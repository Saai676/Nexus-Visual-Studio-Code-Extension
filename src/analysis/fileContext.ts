/**
 * File-first context.
 *
 * Reads the text of the active document (including unsaved edits) and
 * records what can be seen directly in it: imports and aliases,
 * function and class declarations, assignments, and where names occur.
 *
 * Everything recorded here is DIRECT SOURCE EVIDENCE with an exact
 * location. This module never guesses what code does at runtime.
 */
import type { SourceRange } from "../investigationModel";
import type { LanguageProfile } from "./languageProfiles";
import { LineIndex } from "./text";
import { stringContent, tokenize, type Token } from "./tokenizer";

/** Files larger than this are analysed in part, and the panel says so. */
export const MAX_ANALYZED_CHARACTERS = 600_000;
const HEAD_CHARACTERS = 200_000;
const MAX_STATEMENT_LINES = 60;

export type ImportForm = "module" | "member" | "namespace" | "default";

export interface ImportBinding {
  /** The name this file uses, e.g. "st". */
  readonly localName: string;
  /** The original name, e.g. "streamlit" or "join". */
  readonly importedName: string;
  /** The module or package the import names, e.g. "streamlit" or "os.path". */
  readonly module: string;
  readonly isAlias: boolean;
  readonly form: ImportForm;
  /**
   * explicit:   the local name is written in the import statement.
   * convention: the local name follows a language convention (Go package names).
   */
  readonly certainty: "explicit" | "convention";
  readonly nameRange: SourceRange;
  readonly statementRange: SourceRange;
  readonly statementText: string;
  readonly line: number;
}

/** An import that brings in names without listing them (e.g. `from x import *`). */
export interface WildcardImport {
  readonly module: string;
  readonly line: number;
  readonly statementRange: SourceRange;
  readonly statementText: string;
}

export type DeclarationKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "struct"
  | "trait"
  | "module";

export interface Declaration {
  readonly name: string;
  readonly kind: DeclarationKind;
  readonly line: number;
  readonly endLine: number;
  readonly nameRange: SourceRange;
  readonly headerText: string;
  readonly parameters: readonly ParameterInfo[];
  /** Index of the enclosing declaration, or -1 at file level. */
  readonly parent: number;
}

export interface ParameterInfo {
  readonly name: string;
  readonly range: SourceRange;
}

export type AssignmentForm =
  | "assignment"
  | "declaration"
  | "update"
  | "loop-variable"
  | "with-as"
  | "except-as"
  | "parameter";

export interface Assignment {
  readonly name: string;
  readonly form: AssignmentForm;
  /** All names introduced together, in order (for `a, b = ...`). */
  readonly siblingNames: readonly string[];
  readonly indexAmongSiblings: number;
  /**
   * How the value is split between sibling names.
   * positional: by order (`a, b = ...`, `[a, b] = ...`).
   * by-name:    by property name (`const { a, b } = ...`).
   */
  readonly unpack: "none" | "positional" | "by-name";
  readonly nameRange: SourceRange;
  readonly line: number;
  /** The expression on the other side, when one is written. */
  readonly valueText: string;
  readonly statementText: string;
  readonly statementRange: SourceRange;
  /** Index of the enclosing declaration, or -1 at file level. */
  readonly scope: number;
}

export type OccurrenceRole =
  | "introduction"
  | "call"
  | "member-root"
  | "member"
  | "keyword-argument"
  | "property-key"
  | "use";

export interface Occurrence {
  readonly range: SourceRange;
  readonly line: number;
  readonly lineText: string;
  readonly role: OccurrenceRole;
  /** For member-root: the name reached through this one (st.title -> "title"). */
  readonly memberName?: string;
  /** For member: the name it was reached through (st.title -> "st"). */
  readonly ownerName?: string;
  /** Whether the member reached through this name is written as a call. */
  readonly memberIsCalled?: boolean;
}

export interface Statement {
  /** Index of the first token in FileContext.tokens. */
  readonly first: number;
  /** Index just past the last token. */
  readonly end: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly indent: number;
}

export interface AnalysisWindow {
  readonly startLine: number;
  readonly endLine: number;
}

export interface FileContext {
  readonly profile: LanguageProfile;
  readonly lines: LineIndex;
  /** Code tokens only; comments are removed. */
  readonly tokens: readonly Token[];
  /** For each token, the index of the innermost bracket that encloses it, or -1. */
  readonly enclosingBracket: readonly number[];
  /** For each opening bracket token index, the index of its closing bracket. */
  readonly matchingBracket: ReadonlyMap<number, number>;
  readonly statements: readonly Statement[];
  readonly imports: readonly ImportBinding[];
  readonly wildcardImports: readonly WildcardImport[];
  readonly declarations: readonly Declaration[];
  readonly assignments: readonly Assignment[];
  readonly totalLines: number;
  /** Present when only part of a very large file was analysed. */
  readonly partial?: readonly AnalysisWindow[];
}

const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" };

export function buildFileContext(
  text: string,
  profile: LanguageProfile,
  focusOffset = 0,
): FileContext {
  const lines = new LineIndex(text);
  const { tokens, partial } = tokenizeBounded(text, profile, lines, focusOffset);
  const { enclosingBracket, matchingBracket } = matchBrackets(tokens);
  const statements = splitStatements(tokens, enclosingBracket, profile);

  const base: FileContext = {
    profile,
    lines,
    tokens,
    enclosingBracket,
    matchingBracket,
    statements,
    imports: [],
    wildcardImports: [],
    declarations: [],
    assignments: [],
    totalLines: lines.lineCount,
    partial,
  };

  const importResult = collectImports(base);
  const declarations = collectDeclarations(base);
  const withDeclarations: FileContext = { ...base, ...importResult, declarations };
  const assignments = collectAssignments(withDeclarations);

  return { ...withDeclarations, assignments };
}

function tokenizeBounded(
  text: string,
  profile: LanguageProfile,
  lines: LineIndex,
  focusOffset: number,
): { tokens: Token[]; partial?: AnalysisWindow[] } {
  if (text.length <= MAX_ANALYZED_CHARACTERS) {
    return { tokens: tokenize(text, profile).filter(isCode) };
  }

  // Very large file: analyse the top (where imports usually are) and a window around the selection.
  const headEnd = lines.lineStartOffset(lines.positionAt(HEAD_CHARACTERS).line);
  const half = (MAX_ANALYZED_CHARACTERS - HEAD_CHARACTERS) / 2;
  const windowStart = lines.lineStartOffset(lines.positionAt(Math.max(0, focusOffset - half)).line);
  const windowEnd = lines.lineStartOffset(
    lines.positionAt(Math.min(text.length, focusOffset + half)).line,
  );

  if (windowStart <= headEnd) {
    const end = Math.max(headEnd, windowEnd);
    return {
      tokens: tokenize(text.slice(0, end), profile).filter(isCode),
      partial: [{ startLine: 0, endLine: lines.positionAt(end).line }],
    };
  }

  const head = tokenize(text.slice(0, headEnd), profile).filter(isCode);
  const window = tokenize(text.slice(windowStart, windowEnd), profile, {
    baseOffset: windowStart,
    baseLine: lines.positionAt(windowStart).line,
  }).filter(isCode);

  return {
    tokens: [...head, ...window],
    partial: [
      { startLine: 0, endLine: lines.positionAt(headEnd).line },
      { startLine: lines.positionAt(windowStart).line, endLine: lines.positionAt(windowEnd).line },
    ],
  };
}

function isCode(token: Token): boolean {
  return token.kind !== "comment";
}

function matchBrackets(tokens: readonly Token[]): {
  enclosingBracket: number[];
  matchingBracket: Map<number, number>;
} {
  const enclosingBracket: number[] = new Array<number>(tokens.length).fill(-1);
  const matchingBracket = new Map<number, number>();
  const stack: number[] = [];

  tokens.forEach((token, index) => {
    if (token.kind === "punct" && CLOSERS[token.text]) {
      // Close the nearest matching opener; tolerate unbalanced code.
      for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
        if (tokens[stack[depth]].text === CLOSERS[token.text]) {
          matchingBracket.set(stack[depth], index);
          stack.length = depth;
          break;
        }
      }
    }

    enclosingBracket[index] = stack.length > 0 ? stack[stack.length - 1] : -1;

    if (token.kind === "punct" && OPENERS.has(token.text)) {
      stack.push(index);
    }
  });

  return { enclosingBracket, matchingBracket };
}

/**
 * Groups tokens into statements. A statement starts on a new line that
 * is not inside round or square brackets (and, for Python, not inside
 * curly brackets either).
 */
function splitStatements(
  tokens: readonly Token[],
  enclosingBracket: readonly number[],
  profile: LanguageProfile,
): Statement[] {
  const statements: Statement[] = [];
  let first = 0;

  const continuesStatement = (index: number): boolean => {
    let bracket = enclosingBracket[index];
    while (bracket !== -1) {
      const text = tokens[bracket].text;
      if (text === "(" || text === "[" || (text === "{" && profile.blockStyle === "indent")) {
        return true;
      }
      bracket = enclosingBracket[bracket];
    }
    return false;
  };

  for (let index = 1; index <= tokens.length; index += 1) {
    const atEnd = index === tokens.length;
    const startsNewLine = !atEnd && tokens[index].line !== tokens[index - 1].line;
    const tooLong = !atEnd && tokens[index].line - tokens[first].line > MAX_STATEMENT_LINES;

    if (atEnd || (startsNewLine && (!continuesStatement(index) || tooLong))) {
      if (index > first) {
        statements.push({
          first,
          end: index,
          startLine: tokens[first].line,
          endLine: tokens[index - 1].line,
          indent: tokens[first].column,
        });
      }
      first = index;
    }
  }

  return statements;
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

interface ImportResult {
  imports: ImportBinding[];
  wildcardImports: WildcardImport[];
}

function collectImports(context: FileContext): ImportResult {
  const result: ImportResult = { imports: [], wildcardImports: [] };

  for (const statement of context.statements) {
    const tokens = context.tokens.slice(statement.first, statement.end);
    switch (context.profile.family) {
      case "python":
        pythonImports(context, statement, tokens, result);
        break;
      case "javascript":
        javascriptImports(context, statement, tokens, result);
        break;
      case "java":
        javaImports(context, statement, tokens, result);
        break;
      case "c":
        cImports(context, statement, tokens, result);
        break;
      case "csharp":
        csharpImports(context, statement, tokens, result);
        break;
      case "go":
        goImports(context, statement, tokens, result);
        break;
      case "rust":
        rustImports(context, statement, tokens, result);
        break;
      default:
        break;
    }
  }

  return result;
}

function statementRange(context: FileContext, statement: Statement): SourceRange {
  return context.lines.rangeOf(
    context.tokens[statement.first].start,
    context.tokens[statement.end - 1].end,
  );
}

function statementText(context: FileContext, statement: Statement): string {
  return context.lines.text
    .slice(context.tokens[statement.first].start, context.tokens[statement.end - 1].end)
    .replace(/\s*\n\s*/g, " ");
}

function tokenRange(context: FileContext, token: Token): SourceRange {
  return context.lines.rangeOf(token.start, token.end);
}

function addBinding(
  context: FileContext,
  statement: Statement,
  result: ImportResult,
  nameToken: Token,
  importedName: string,
  module: string,
  form: ImportForm,
  certainty: "explicit" | "convention" = "explicit",
  localName = nameToken.text,
): void {
  result.imports.push({
    localName,
    importedName,
    module,
    isAlias:
      form !== "default" &&
      form !== "namespace" &&
      !(context.profile.family === "javascript" && form === "module") &&
      localName !== importedName.split(/[./:]/).pop() &&
      localName !== importedName,
    form,
    certainty,
    nameRange: tokenRange(context, nameToken),
    statementRange: statementRange(context, statement),
    statementText: statementText(context, statement),
    line: nameToken.line,
  });
}

function addWildcard(
  context: FileContext,
  statement: Statement,
  result: ImportResult,
  module: string,
): void {
  result.wildcardImports.push({
    module,
    line: statement.startLine,
    statementRange: statementRange(context, statement),
    statementText: statementText(context, statement),
  });
}

function isName(token: Token | undefined): token is Token {
  return token !== undefined && (token.kind === "identifier" || token.kind === "keyword");
}

function pythonImports(
  context: FileContext,
  statement: Statement,
  tokens: readonly Token[],
  result: ImportResult,
): void {
  if (tokens[0].text === "import" && tokens[0].kind === "keyword") {
    let index = 1;
    while (index < tokens.length) {
      const pathStart = index;
      while (index < tokens.length && (isName(tokens[index]) || tokens[index].text === ".") && tokens[index].text !== "as") {
        index += 1;
      }
      const path = tokens.slice(pathStart, index);
      if (path.length === 0) {
        break;
      }
      const dotted = path.map((token) => token.text).join("");

      if (tokens[index]?.text === "as" && isName(tokens[index + 1])) {
        addBinding(context, statement, result, tokens[index + 1], dotted, dotted, "module");
        index += 2;
      } else {
        // `import a.b` makes the top-level name `a` available.
        addBinding(context, statement, result, path[0], path[0].text, dotted, "module");
      }

      if (tokens[index]?.text !== ",") {
        break;
      }
      index += 1;
    }
    return;
  }

  if (tokens[0].text === "from" && tokens[0].kind === "keyword") {
    const importIndex = tokens.findIndex((token) => token.text === "import" && token.kind === "keyword");
    if (importIndex === -1) {
      return;
    }
    const module = tokens.slice(1, importIndex).map((token) => token.text).join("");

    for (let index = importIndex + 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.text === "*") {
        addWildcard(context, statement, result, module);
      } else if (isName(token) && token.text !== "as") {
        if (tokens[index + 1]?.text === "as" && isName(tokens[index + 2])) {
          addBinding(context, statement, result, tokens[index + 2], token.text, module, "member");
          index += 2;
        } else {
          addBinding(context, statement, result, token, token.text, module, "member");
        }
      }
    }
  }
}

function javascriptImports(
  context: FileContext,
  statement: Statement,
  tokens: readonly Token[],
  result: ImportResult,
): void {
  const first = tokens[0];

  if (first.text === "import" && first.kind === "keyword" && tokens[1]?.text !== "(") {
    const moduleToken = [...tokens].reverse().find((token) => token.kind === "string");
    if (!moduleToken) {
      return;
    }
    const module = stringContent(moduleToken.text);
    let index = 1;
    if (tokens[index]?.text === "type" && tokens[index].kind === "keyword") {
      index += 1;
    }

    for (; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.text === "from" || token.kind === "string") {
        break;
      }

      if (token.text === "*" && tokens[index + 1]?.text === "as" && isName(tokens[index + 2])) {
        addBinding(context, statement, result, tokens[index + 2], "*", module, "namespace");
        index += 2;
      } else if (token.text === "{") {
        index = namedImportList(context, statement, tokens, index + 1, module, result);
      } else if (isName(token)) {
        addBinding(context, statement, result, token, "default", module, "default");
      }
    }
    return;
  }

  // const fs = require("fs") / const { join } = require("path")
  const declarator = ["const", "let", "var"].includes(first.text) ? 1 : -1;
  if (declarator === -1) {
    return;
  }
  const requireIndex = tokens.findIndex(
    (token, index) =>
      token.text === "require" && tokens[index + 1]?.text === "(" && tokens[index + 2]?.kind === "string",
  );
  if (requireIndex === -1) {
    return;
  }
  const module = stringContent(tokens[requireIndex + 2].text);
  const afterCall = tokens[requireIndex + 4];
  const target = tokens[declarator];

  if (isName(target) && tokens[declarator + 1]?.text === "=" && tokens[declarator + 2] === tokens[requireIndex]) {
    if (afterCall?.text === "." && isName(tokens[requireIndex + 5])) {
      addBinding(context, statement, result, target, tokens[requireIndex + 5].text, module, "member");
    } else {
      addBinding(context, statement, result, target, module, module, "module");
    }
  } else if (target?.text === "{") {
    for (let index = declarator + 1; index < tokens.length && tokens[index].text !== "}"; index += 1) {
      const token = tokens[index];
      if (!isName(token)) {
        continue;
      }
      if (tokens[index + 1]?.text === ":" && isName(tokens[index + 2])) {
        addBinding(context, statement, result, tokens[index + 2], token.text, module, "member");
        index += 2;
      } else {
        addBinding(context, statement, result, token, token.text, module, "member");
      }
    }
  }
}

function namedImportList(
  context: FileContext,
  statement: Statement,
  tokens: readonly Token[],
  from: number,
  module: string,
  result: ImportResult,
): number {
  let index = from;
  for (; index < tokens.length && tokens[index].text !== "}"; index += 1) {
    let token = tokens[index];
    if (token.text === "type" && isName(tokens[index + 1]) && tokens[index + 1].text !== "as") {
      index += 1;
      token = tokens[index];
    }
    if (!isName(token)) {
      continue;
    }
    if (tokens[index + 1]?.text === "as" && isName(tokens[index + 2])) {
      addBinding(context, statement, result, tokens[index + 2], token.text, module, "member");
      index += 2;
    } else {
      addBinding(context, statement, result, token, token.text, module, "member");
    }
  }
  return index;
}

function javaImports(
  context: FileContext,
  statement: Statement,
  tokens: readonly Token[],
  result: ImportResult,
): void {
  if (tokens[0].text !== "import" || tokens[0].kind !== "keyword") {
    return;
  }
  const path = tokens.slice(1).filter((token) => token.text !== ";" && token.text !== "static");
  const dotted = path.map((token) => token.text).join("");
  const last = path[path.length - 1];

  if (!last) {
    return;
  }
  if (last.text === "*") {
    addWildcard(context, statement, result, dotted.replace(/\.\*$/, ""));
  } else if (isName(last)) {
    addBinding(context, statement, result, last, dotted, dotted.split(".").slice(0, -1).join("."), "member");
  }
}

function cImports(
  context: FileContext,
  statement: Statement,
  tokens: readonly Token[],
  result: ImportResult,
): void {
  if (tokens[0].text === "#" && tokens[1]?.text === "include") {
    const rest = tokens.slice(2);
    const module =
      rest[0]?.kind === "string"
        ? stringContent(rest[0].text)
        : rest.map((token) => token.text).join("").replace(/^<|>$/g, "");
    if (module) {
      addWildcard(context, statement, result, module);
    }
    return;
  }

  if (tokens[0].text === "using") {
    if (tokens[1]?.text === "namespace") {
      addWildcard(
        context,
        statement,
        result,
        tokens.slice(2).filter((token) => token.text !== ";").map((token) => token.text).join(""),
      );
    } else if (isName(tokens[1]) && tokens[2]?.text === "=") {
      const target = tokens.slice(3).filter((token) => token.text !== ";").map((token) => token.text).join("");
      addBinding(context, statement, result, tokens[1], target, target, "member");
    }
  }
}

function csharpImports(
  context: FileContext,
  statement: Statement,
  tokens: readonly Token[],
  result: ImportResult,
): void {
  if (tokens[0].text !== "using" || tokens[0].kind !== "keyword" || tokens[1]?.text === "(") {
    return;
  }
  const rest = tokens.slice(1).filter((token) => token.text !== ";" && token.text !== "static");
  if (rest.length === 0 || rest.some((token) => token.text === "(" || token.text === "var")) {
    return;
  }

  if (isName(rest[0]) && rest[1]?.text === "=") {
    const target = rest.slice(2).map((token) => token.text).join("");
    addBinding(context, statement, result, rest[0], target, target, "member");
  } else {
    addWildcard(context, statement, result, rest.map((token) => token.text).join(""));
  }
}

function goImports(
  context: FileContext,
  statement: Statement,
  tokens: readonly Token[],
  result: ImportResult,
): void {
  if (tokens[0].text !== "import" || tokens[0].kind !== "keyword") {
    return;
  }

  tokens.forEach((token, index) => {
    if (token.kind !== "string") {
      return;
    }
    const module = stringContent(token.text);
    const previous = tokens[index - 1];

    if (previous?.text === ".") {
      addWildcard(context, statement, result, module);
    } else if (previous && previous.kind === "identifier" && previous.text !== "_") {
      addBinding(context, statement, result, previous, module, module, "module");
    } else if (previous?.text !== "_") {
      const conventional = module.split("/").pop() ?? module;
      addBinding(context, statement, result, token, module, module, "module", "convention", conventional);
    }
  });
}

function rustImports(
  context: FileContext,
  statement: Statement,
  tokens: readonly Token[],
  result: ImportResult,
): void {
  const useIndex = tokens[0].text === "use" ? 0 : tokens[0].text === "pub" && tokens[1]?.text === "use" ? 1 : -1;
  if (useIndex === -1) {
    return;
  }

  const walk = (from: number, prefix: string): number => {
    let index = from;
    let path = prefix;
    let last: Token | undefined;

    while (index < tokens.length) {
      const token = tokens[index];

      if (token.text === "{") {
        index += 1;
        while (index < tokens.length && tokens[index].text !== "}") {
          index = walk(index, path);
          if (tokens[index]?.text === ",") {
            index += 1;
          }
        }
        return index + 1;
      }

      if (token.text === "*") {
        addWildcard(context, statement, result, path.replace(/::$/, ""));
        return index + 1;
      }

      if (token.text === "::") {
        path += "::";
        index += 1;
        continue;
      }

      if (token.text === "as" && isName(tokens[index + 1]) && last) {
        addBinding(context, statement, result, tokens[index + 1], path, path.split("::").slice(0, -1).join("::"), "member");
        return index + 2;
      }

      if (isName(token)) {
        path += token.text;
        last = token;
        index += 1;
        continue;
      }

      break;
    }

    if (last && last.text !== "self") {
      addBinding(context, statement, result, last, path, path.split("::").slice(0, -1).join("::"), "member");
    }
    return index;
  };

  walk(useIndex + 1, "");
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

interface RawDeclaration {
  name: string;
  kind: DeclarationKind;
  nameIndex: number;
  /** Token index of the "(" that opens the parameter list, if any. */
  parameterOpen?: number;
  /** Token index of a single parameter written without brackets (`x => ...`). */
  loneParameter?: number;
  endLine: number;
}

const NOT_A_FUNCTION_NAME = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "else", "do", "new",
  "throw", "typeof", "await", "sizeof", "foreach", "using", "lock", "when", "elif",
  "constructor_placeholder", "super", "this", "delete", "case",
]);

function collectDeclarations(context: FileContext): Declaration[] {
  const raw: RawDeclaration[] = [];
  const { tokens, profile } = context;

  if (profile.family === "python") {
    for (const statement of context.statements) {
      let index = statement.first;
      if (tokens[index].text === "async") {
        index += 1;
      }
      const keyword = tokens[index];
      const name = tokens[index + 1];
      if (keyword?.kind !== "keyword" || !isName(name)) {
        continue;
      }
      if (keyword.text === "def") {
        raw.push({
          name: name.text,
          kind: "function",
          nameIndex: index + 1,
          parameterOpen: tokens[index + 2]?.text === "(" ? index + 2 : undefined,
          endLine: pythonBlockEnd(context, statement),
        });
      } else if (keyword.text === "class") {
        raw.push({
          name: name.text,
          kind: "class",
          nameIndex: index + 1,
          endLine: pythonBlockEnd(context, statement),
        });
      }
    }
  } else if (profile.family !== "generic") {
    collectBraceDeclarations(context, raw);
  }

  raw.sort((a, b) => tokens[a.nameIndex].start - tokens[b.nameIndex].start);

  const declarations: Declaration[] = [];
  raw.forEach((entry) => {
    const nameToken = tokens[entry.nameIndex];
    let parent = -1;
    for (let candidate = declarations.length - 1; candidate >= 0; candidate -= 1) {
      const other = declarations[candidate];
      if (other.line < nameToken.line && other.endLine >= entry.endLine && other.endLine >= nameToken.line) {
        parent = candidate;
        break;
      }
    }

    const parentKind = parent === -1 ? undefined : declarations[parent].kind;
    const kind =
      entry.kind === "function" && parentKind !== undefined && ["class", "struct", "interface", "trait"].includes(parentKind)
        ? "method"
        : entry.kind;

    declarations.push({
      name: entry.name,
      kind,
      line: nameToken.line,
      endLine: Math.max(entry.endLine, nameToken.line),
      nameRange: tokenRange(context, nameToken),
      headerText: context.lines.lineText(nameToken.line).trim(),
      parameters:
        entry.parameterOpen !== undefined
          ? readParameters(context, entry.parameterOpen)
          : entry.loneParameter !== undefined
            ? [{ name: tokens[entry.loneParameter].text, range: tokenRange(context, tokens[entry.loneParameter]) }]
            : [],
      parent,
    });
  });

  return declarations;
}

function pythonBlockEnd(context: FileContext, header: Statement): number {
  const position = context.statements.indexOf(header);
  let endLine = header.endLine;

  for (let index = position + 1; index < context.statements.length; index += 1) {
    const statement = context.statements[index];
    if (statement.indent <= header.indent) {
      break;
    }
    endLine = statement.endLine;
  }

  return endLine;
}

function collectBraceDeclarations(context: FileContext, raw: RawDeclaration[]): void {
  const { tokens, profile } = context;
  const family = profile.family;
  const typeKinds: Readonly<Record<string, DeclarationKind>> = {
    class: "class",
    interface: "interface",
    enum: "enum",
    struct: "struct",
    trait: "trait",
    record: "class",
    namespace: "module",
    mod: "module",
    union: "struct",
  };
  const seenNameIndexes = new Set<number>();

  const add = (entry: RawDeclaration): void => {
    if (!seenNameIndexes.has(entry.nameIndex)) {
      seenNameIndexes.add(entry.nameIndex);
      raw.push(entry);
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    const previous = tokens[index - 1];

    // class Foo / interface Foo / struct Foo / enum Foo / trait Foo
    if (token.kind === "keyword" && typeKinds[token.text] && isName(next) && next.kind === "identifier") {
      if (!(family === "go") && !(previous && profile.memberOperators.includes(previous.text))) {
        add({ name: next.text, kind: typeKinds[token.text], nameIndex: index + 1, endLine: braceBlockEnd(context, index + 1) });
      }
      continue;
    }

    // TypeScript: type Foo = ...   Go: type Foo struct { ... }
    if (token.kind === "keyword" && token.text === "type" && next?.kind === "identifier") {
      const after = tokens[index + 2];
      if (family === "javascript" && after?.text !== "=" && after?.text !== "<") {
        continue;
      }
      const kind: DeclarationKind =
        after?.text === "struct" ? "struct" : after?.text === "interface" ? "interface" : "type";
      add({ name: next.text, kind, nameIndex: index + 1, endLine: braceBlockEnd(context, index + 1) });
      continue;
    }

    // function foo( / fn foo( / func foo( / func (r T) foo(
    if (token.kind === "keyword" && ["function", "fn", "func"].includes(token.text)) {
      let nameIndex = index + 1;
      if (tokens[nameIndex]?.text === "*") {
        nameIndex += 1;
      }
      if (token.text === "func" && tokens[nameIndex]?.text === "(") {
        const close = context.matchingBracket.get(nameIndex);
        if (close === undefined) {
          continue;
        }
        nameIndex = close + 1;
      }
      const nameToken = tokens[nameIndex];
      if (nameToken?.kind === "identifier") {
        const open = findParameterOpen(context, nameIndex + 1);
        add({
          name: nameToken.text,
          kind: "function",
          nameIndex,
          parameterOpen: open,
          endLine: braceBlockEnd(context, nameIndex),
        });
      }
      continue;
    }

    // const foo = (a, b) => ... / const foo = function (...) / const foo = async x => ...
    if (family === "javascript" && token.kind === "identifier" && next?.text === "=" && previous && ["const", "let", "var"].includes(previous.text)) {
      let valueIndex = index + 2;
      if (tokens[valueIndex]?.text === "async") {
        valueIndex += 1;
      }
      const value = tokens[valueIndex];
      let parameterOpen: number | undefined;
      let loneParameter: number | undefined;
      let isFunction = false;

      if (value?.text === "function") {
        isFunction = true;
        parameterOpen = findParameterOpen(context, valueIndex + 1);
      } else if (value?.text === "(") {
        const close = context.matchingBracket.get(valueIndex);
        if (close !== undefined && arrowFollows(tokens, close + 1)) {
          isFunction = true;
          parameterOpen = valueIndex;
        }
      } else if (value?.kind === "identifier" && tokens[valueIndex + 1]?.text === "=>") {
        isFunction = true;
        loneParameter = valueIndex;
      }

      if (isFunction) {
        add({
          name: token.text,
          kind: "function",
          nameIndex: index,
          parameterOpen,
          loneParameter,
          endLine: braceBlockEnd(context, valueIndex),
        });
      }
      continue;
    }

    // name(...) { ... }  — methods, and C/Java/C# functions with a return type before the name.
    if (token.kind === "identifier" && next?.text === "(" && !NOT_A_FUNCTION_NAME.has(token.text) && ["javascript", "java", "c", "csharp"].includes(family)) {
      const close = context.matchingBracket.get(index + 1);
      if (close === undefined) {
        continue;
      }
      if (previous && (profile.memberOperators.includes(previous.text) && previous.text !== "::")) {
        continue;
      }
      const bodyOpen = findBodyOpen(context, close + 1);
      if (bodyOpen === undefined) {
        continue;
      }

      const insideBracket = context.enclosingBracket[index];
      const insideBraces = insideBracket === -1 || tokens[insideBracket].text === "{";
      if (!insideBraces) {
        continue;
      }

      if (family === "javascript") {
        // Only accept inside a class body: `{` directly owned by a class/interface header.
        if (insideBracket === -1 || !isTypeBody(context, insideBracket)) {
          continue;
        }
        if (previous && ["=", "(", ",", "return", "=>", "new", "await", "+", "!", "&&", "||", "?", ":"].includes(previous.text) && previous.kind !== "punct") {
          continue;
        }
      } else {
        // Needs something that reads like a return type, or to be a constructor in a type body.
        const hasReturnType =
          previous !== undefined &&
          (previous.kind === "identifier" || previous.kind === "keyword" || [">", "]", "*", "&", "::", "~"].includes(previous.text)) &&
          !["return", "new", "else", "throw", "case", "await", "in", "is", "as", "delete", "typeof", "sizeof"].includes(previous.text);
        const isConstructor = insideBracket !== -1 && isTypeBody(context, insideBracket);
        if (!hasReturnType && !isConstructor) {
          continue;
        }
      }

      add({
        name: token.text,
        kind: "function",
        nameIndex: index,
        parameterOpen: index + 1,
        endLine: tokens[context.matchingBracket.get(bodyOpen) ?? bodyOpen].line,
      });
    }
  }
}

function arrowFollows(tokens: readonly Token[], from: number): boolean {
  if (tokens[from]?.text === "=>") {
    return true;
  }
  if (tokens[from]?.text !== ":") {
    return false;
  }
  // (a: string): Promise<void> => ...
  const line = tokens[from].line;
  for (let index = from + 1; index < tokens.length && tokens[index].line <= line + 2; index += 1) {
    if (tokens[index].text === "=>") {
      return true;
    }
    if (["{", ";", "=", "("].includes(tokens[index].text)) {
      return false;
    }
  }
  return false;
}

function findParameterOpen(context: FileContext, from: number): number | undefined {
  const { tokens } = context;
  let index = from;

  // Skip a name (function expressions) and generic parameters such as <T>.
  if (tokens[index]?.kind === "identifier") {
    index += 1;
  }
  if (tokens[index]?.text === "<") {
    let depth = 0;
    for (; index < tokens.length; index += 1) {
      if (tokens[index].text === "<") depth += 1;
      if (tokens[index].text === ">") depth -= 1;
      if (tokens[index].text === ">>") depth -= 2;
      if (depth <= 0) {
        index += 1;
        break;
      }
    }
  }

  return tokens[index]?.text === "(" ? index : undefined;
}

/** After a parameter list, finds the "{" that opens the body, if the code has one. */
function findBodyOpen(context: FileContext, from: number): number | undefined {
  const { tokens } = context;
  const startLine = tokens[from - 1]?.line ?? 0;

  for (let index = from; index < tokens.length && tokens[index].line <= startLine + 3; index += 1) {
    const text = tokens[index].text;
    if (text === "{") {
      return index;
    }
    if ([";", "=", "}", ")", "=>", ","].includes(text)) {
      return undefined;
    }
    if (text === "(" || text === "[" || text === "<") {
      // Skip annotations such as `: Promise<void>` or `throws Foo`.
      const close = context.matchingBracket.get(index);
      if (close !== undefined) {
        index = close;
      }
    }
  }

  return undefined;
}

function isTypeBody(context: FileContext, braceIndex: number): boolean {
  const { tokens } = context;
  const line = tokens[braceIndex].line;

  for (let index = braceIndex - 1; index >= 0 && tokens[index].line >= line - 3; index -= 1) {
    const token = tokens[index];
    if (token.kind === "keyword" && ["class", "interface", "struct", "enum", "record", "trait", "impl"].includes(token.text)) {
      return true;
    }
    if ([";", "}", "{", ")", "="].includes(token.text)) {
      return false;
    }
  }

  return false;
}

function braceBlockEnd(context: FileContext, from: number): number {
  const { tokens } = context;
  const startLine = tokens[from].line;
  let depth = 0;

  for (let index = from; index < tokens.length && tokens[index].line <= startLine + 6; index += 1) {
    const text = tokens[index].text;
    if (text === "(" || text === "[") {
      depth += 1;
    } else if (text === ")" || text === "]") {
      depth -= 1;
    } else if (text === "{" && depth <= 0) {
      const close = context.matchingBracket.get(index);
      return close === undefined ? startLine : tokens[close].line;
    } else if (text === ";" && depth <= 0) {
      return tokens[index].line;
    }
  }

  return startLine;
}

function readParameters(context: FileContext, openIndex: number): ParameterInfo[] {
  const { tokens, profile } = context;
  const closeIndex = context.matchingBracket.get(openIndex);
  if (closeIndex === undefined) {
    return [];
  }

  // Split the parameter list into pieces at top-level commas.
  const pieces: number[][] = [[]];
  for (let index = openIndex + 1; index < closeIndex; index += 1) {
    if (context.enclosingBracket[index] !== openIndex) {
      continue;
    }
    if (tokens[index].text === ",") {
      pieces.push([]);
    } else {
      pieces[pieces.length - 1].push(index);
    }
  }

  const modifiers = new Set(["public", "private", "protected", "readonly", "final", "const", "mut", "ref", "out", "in", "params", "this", "static", "override"]);
  const parameters: ParameterInfo[] = [];
  const typedLater = pieces.map((piece) => piece.filter((index) => isName(tokens[index])).length >= 2);

  pieces.forEach((piece, pieceIndex) => {
    const names = piece.filter((index) => isName(tokens[index]));
    if (names.length === 0) {
      return;
    }
    let chosen: number | undefined;

    switch (profile.family) {
      case "python":
      case "javascript":
      case "rust":
        // The name comes first: `name`, `name: type`, `name = default`, `*args`, `...rest`.
        chosen = piece.find((index) => isName(tokens[index]) && !modifiers.has(tokens[index].text));
        break;
      case "go":
        // `a, b int` — a lone word is a name only if a later piece carries the type.
        if (names.length >= 2 || typedLater.slice(pieceIndex + 1).some(Boolean)) {
          chosen = names[0];
        }
        break;
      default: {
        // Type comes first: `int count`, `final String name`, `const char *text = "x"`.
        const equals = piece.findIndex((index) => tokens[index].text === "=");
        const scope = equals === -1 ? piece : piece.slice(0, equals);
        const scopedNames = scope.filter((index) => isName(tokens[index]));
        if (scopedNames.length >= 2) {
          chosen = scopedNames[scopedNames.length - 1];
        }
        break;
      }
    }

    if (chosen !== undefined && tokens[chosen].text !== "self" && tokens[chosen].text !== "void") {
      parameters.push({ name: tokens[chosen].text, range: tokenRange(context, tokens[chosen]) });
    }
  });

  return parameters;
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

const UPDATE_OPERATORS = new Set(["+=", "-=", "*=", "/=", "%=", "**=", "//=", "|=", "&=", "^=", ">>=", "<<=", "&&=", "||=", "??="]);

function collectAssignments(context: FileContext): Assignment[] {
  const assignments: Assignment[] = [];
  const { tokens, profile } = context;

  const add = (
    statement: Statement,
    nameIndexes: readonly number[],
    form: AssignmentForm,
    valueFrom: number,
    valueTo: number,
  ): void => {
    const siblingNames = nameIndexes.map((index) => tokens[index].text);
    const valueText =
      valueFrom < valueTo && valueFrom < tokens.length
        ? context.lines.text.slice(tokens[valueFrom].start, tokens[Math.min(valueTo, tokens.length) - 1].end).replace(/\s*\n\s*/g, " ")
        : "";

    nameIndexes.forEach((nameIndex, position) => {
      const token = tokens[nameIndex];
      const bracket = context.enclosingBracket[nameIndex];
      const closing = bracket === -1 ? undefined : context.matchingBracket.get(bracket);
      const insideBraces =
        profile.family === "javascript" &&
        form === "declaration" &&
        bracket !== -1 &&
        tokens[bracket].text === "{" &&
        closing !== undefined &&
        tokens[closing + 1]?.text === "=";
      assignments.push({
        name: token.text,
        form,
        siblingNames,
        indexAmongSiblings: position,
        unpack: insideBraces ? "by-name" : nameIndexes.length > 1 ? "positional" : "none",
        nameRange: tokenRange(context, token),
        line: token.line,
        valueText,
        statementText: statementText(context, statement),
        statementRange: statementRange(context, statement),
        scope: enclosingDeclaration(context.declarations, token.line),
      });
    });
  };

  for (const statement of context.statements) {
    switch (profile.family) {
      case "python":
        pythonAssignments(context, statement, add);
        break;
      case "javascript":
        javascriptAssignments(context, statement, add);
        break;
      case "go":
        goAssignments(context, statement, add);
        break;
      case "rust":
        rustAssignments(context, statement, add);
        break;
      case "java":
      case "c":
      case "csharp":
        typedAssignments(context, statement, add);
        break;
      default:
        break;
    }
  }

  // Parameters are names introduced by a function header.
  context.declarations.forEach((declaration, declarationIndex) => {
    declaration.parameters.forEach((parameter, position) => {
      assignments.push({
        name: parameter.name,
        form: "parameter",
        siblingNames: declaration.parameters.map((entry) => entry.name),
        indexAmongSiblings: position,
        unpack: "none",
        nameRange: parameter.range,
        line: parameter.range.start.line,
        valueText: "",
        statementText: declaration.headerText,
        statementRange: {
          start: { line: declaration.line, character: 0 },
          end: { line: declaration.line, character: context.lines.lineText(declaration.line).length },
        },
        scope: declarationIndex,
      });
    });
  });

  return assignments.sort(
    (a, b) => a.line - b.line || a.nameRange.start.character - b.nameRange.start.character,
  );
}

type AddAssignment = (
  statement: Statement,
  nameIndexes: readonly number[],
  form: AssignmentForm,
  valueFrom: number,
  valueTo: number,
) => void;

/** Innermost declaration whose line range contains the line, or -1. */
export function enclosingDeclaration(declarations: readonly Declaration[], line: number): number {
  let best = -1;
  declarations.forEach((declaration, index) => {
    if (declaration.line <= line && declaration.endLine >= line) {
      if (best === -1 || declaration.line >= declarations[best].line) {
        best = index;
      }
    }
  });
  return best;
}

/** True when the token sits directly in the statement, not inside brackets opened within it. */
function atStatementLevel(context: FileContext, statement: Statement, index: number): boolean {
  return context.enclosingBracket[index] === context.enclosingBracket[statement.first];
}

/** Collects simple names from a target such as `a`, `a, b`, `(a, b)`, `[a, *rest]`. */
function targetNames(context: FileContext, from: number, to: number): number[] | undefined {
  const { tokens, profile } = context;
  const names: number[] = [];

  for (let index = from; index < to; index += 1) {
    const token = tokens[index];
    if (token.kind === "identifier") {
      const next = tokens[index + 1];
      const previous = tokens[index - 1];
      // `obj.attr = ...` and `items[0] = ...` do not introduce a plain name.
      if (
        (next && index + 1 < to && (profile.memberOperators.includes(next.text) || next.text === "[" || next.text === "(")) ||
        (previous && index - 1 >= from && profile.memberOperators.includes(previous.text))
      ) {
        return undefined;
      }
      names.push(index);
    } else if (!["(", ")", "[", "]", ",", "*", "..."].includes(token.text)) {
      return undefined;
    }
  }

  return names.length > 0 ? names : undefined;
}

function pythonAssignments(context: FileContext, statement: Statement, add: AddAssignment): void {
  const { tokens } = context;
  const first = tokens[statement.first];
  const level = (index: number): boolean => atStatementLevel(context, statement, index);

  // Walrus: (name := value)
  for (let index = statement.first + 1; index < statement.end; index += 1) {
    if (tokens[index].text === ":=" && tokens[index - 1].kind === "identifier") {
      add(statement, [index - 1], "assignment", index + 1, statement.end);
    }
  }

  if (first.kind === "keyword") {
    let start = statement.first;
    if (first.text === "async") {
      start += 1;
    }
    const keyword = tokens[start]?.text;

    if (keyword === "for") {
      const inIndex = findToken(tokens, start + 1, statement.end, (token, index) => token.text === "in" && level(index));
      if (inIndex !== -1) {
        const names = targetNames(context, start + 1, inIndex);
        const colon = lastColon(context, statement);
        if (names) {
          add(statement, names, "loop-variable", inIndex + 1, colon);
        }
      }
    } else if (keyword === "with" || keyword === "except") {
      for (let index = start + 1; index < statement.end; index += 1) {
        if (tokens[index].text === "as" && tokens[index].kind === "keyword") {
          const names: number[] = [];
          for (let cursor = index + 1; cursor < statement.end; cursor += 1) {
            const token = tokens[cursor];
            if (token.kind === "identifier") {
              names.push(cursor);
            } else if (!["(", ")"].includes(token.text) && !(token.text === "," && context.enclosingBracket[cursor] !== context.enclosingBracket[index])) {
              break;
            }
          }
          if (names.length > 0) {
            // The value is whatever is written before `as`, back to the keyword or previous comma.
            let valueStart = index - 1;
            while (valueStart > start + 1 && !(tokens[valueStart - 1].text === "," && level(valueStart - 1))) {
              valueStart -= 1;
            }
            add(statement, names, keyword === "with" ? "with-as" : "except-as", valueStart, index);
          }
        }
      }
    }
    return;
  }

  const equalsIndexes: number[] = [];
  for (let index = statement.first; index < statement.end; index += 1) {
    if (!level(index)) {
      continue;
    }
    if (tokens[index].text === "=") {
      equalsIndexes.push(index);
    } else if (UPDATE_OPERATORS.has(tokens[index].text) && index === statement.first + 1 && tokens[statement.first].kind === "identifier") {
      add(statement, [statement.first], "update", index + 1, statement.end);
      return;
    }
  }

  if (equalsIndexes.length === 0) {
    return;
  }

  const valueFrom = equalsIndexes[equalsIndexes.length - 1] + 1;
  let targetStart = statement.first;

  for (const equalsIndex of equalsIndexes) {
    let targetEnd = equalsIndex;
    // Annotated assignment: `count: int = 0`
    const colon = findToken(tokens, targetStart, equalsIndex, (token, index) => token.text === ":" && level(index));
    if (colon !== -1) {
      targetEnd = colon;
    }
    const names = targetNames(context, targetStart, targetEnd);
    if (names) {
      add(statement, names, "assignment", valueFrom, statement.end);
    }
    targetStart = equalsIndex + 1;
  }
}

function lastColon(context: FileContext, statement: Statement): number {
  for (let index = statement.end - 1; index > statement.first; index -= 1) {
    if (context.tokens[index].text === ":" && atStatementLevel(context, statement, index)) {
      return index;
    }
  }
  return statement.end;
}

function findToken(
  tokens: readonly Token[],
  from: number,
  to: number,
  predicate: (token: Token, index: number) => boolean,
): number {
  for (let index = from; index < to; index += 1) {
    if (predicate(tokens[index], index)) {
      return index;
    }
  }
  return -1;
}

/** End of an expression that starts at `from`: the next comma or semicolon at the same bracket level. */
function expressionEnd(context: FileContext, from: number, limit: number): number {
  const level = context.enclosingBracket[from] ?? -1;
  for (let index = from; index < limit; index += 1) {
    const token = context.tokens[index];
    if (context.enclosingBracket[index] === level && (token.text === "," || token.text === ";")) {
      return index;
    }
    if (context.matchingBracket.has(level) && index === context.matchingBracket.get(level)) {
      return index;
    }
  }
  return limit;
}

function javascriptAssignments(context: FileContext, statement: Statement, add: AddAssignment): void {
  const { tokens } = context;

  for (let index = statement.first; index < statement.end; index += 1) {
    const token = tokens[index];

    if (token.kind === "keyword" && ["const", "let", "var"].includes(token.text)) {
      let cursor = index + 1;

      // One or more declarators separated by commas.
      while (cursor < statement.end) {
        let names: number[] = [];
        let afterTarget = cursor;

        if (tokens[cursor]?.text === "{" || tokens[cursor]?.text === "[") {
          const close = context.matchingBracket.get(cursor);
          if (close === undefined) {
            break;
          }
          names = destructuredNames(context, cursor, close);
          afterTarget = close + 1;
        } else if (tokens[cursor]?.kind === "identifier") {
          names = [cursor];
          afterTarget = cursor + 1;
        } else {
          break;
        }

        // Skip a type annotation: `let total: number = 0`
        if (tokens[afterTarget]?.text === ":") {
          while (afterTarget < statement.end && !["=", ",", ";", ")"].includes(tokens[afterTarget].text) && !(tokens[afterTarget].kind === "keyword" && ["of", "in"].includes(tokens[afterTarget].text))) {
            const close = context.matchingBracket.get(afterTarget);
            afterTarget = close !== undefined ? close + 1 : afterTarget + 1;
          }
        }

        const separator = tokens[afterTarget];
        if (separator?.text === "=") {
          const end = expressionEnd(context, afterTarget + 1, statement.end);
          add(statement, names, "declaration", afterTarget + 1, end);
          if (tokens[end]?.text === ",") {
            cursor = end + 1;
            continue;
          }
          index = end;
        } else if (separator && (separator.text === "of" || separator.text === "in")) {
          const loopParen = context.enclosingBracket[afterTarget];
          const close = loopParen === -1 ? statement.end : (context.matchingBracket.get(loopParen) ?? statement.end);
          add(statement, names, "loop-variable", afterTarget + 1, close);
          index = afterTarget;
        } else {
          add(statement, names, "declaration", afterTarget, afterTarget);
          if (separator?.text === ",") {
            cursor = afterTarget + 1;
            continue;
          }
          index = afterTarget;
        }
        break;
      }
      continue;
    }

    if (token.kind === "keyword" && token.text === "catch" && tokens[index + 1]?.text === "(" && tokens[index + 2]?.kind === "identifier") {
      add(statement, [index + 2], "except-as", index + 2, index + 2);
    }
  }

  plainReassignment(context, statement, add);
}

function destructuredNames(context: FileContext, open: number, close: number): number[] {
  const { tokens } = context;
  const names: number[] = [];

  for (let index = open + 1; index < close; index += 1) {
    const token = tokens[index];
    if (token.kind !== "identifier") {
      continue;
    }
    // In `{ a: b }` the new name is `b`; in `{ a = 1 }` it is `a`.
    if (tokens[index + 1]?.text === ":" && tokens[open].text === "{") {
      continue;
    }
    const previous = tokens[index - 1];
    if (previous?.text === "=") {
      continue;
    }
    names.push(index);
  }

  return names;
}

function plainReassignment(context: FileContext, statement: Statement, add: AddAssignment): void {
  const { tokens } = context;
  const first = tokens[statement.first];
  const second = tokens[statement.first + 1];

  if (first.kind !== "identifier" || !second) {
    return;
  }
  if (second.text === "=") {
    add(statement, [statement.first], "assignment", statement.first + 2, expressionEnd(context, statement.first + 2, statement.end));
  } else if (UPDATE_OPERATORS.has(second.text)) {
    add(statement, [statement.first], "update", statement.first + 2, expressionEnd(context, statement.first + 2, statement.end));
  }
}

function goAssignments(context: FileContext, statement: Statement, add: AddAssignment): void {
  const { tokens } = context;

  for (let index = statement.first; index < statement.end; index += 1) {
    const token = tokens[index];

    if (token.text === ":=") {
      const names: number[] = [];
      for (let cursor = index - 1; cursor >= statement.first; cursor -= 1) {
        if (tokens[cursor].kind === "identifier") {
          if (tokens[cursor].text !== "_") {
            names.unshift(cursor);
          }
        } else if (tokens[cursor].text !== ",") {
          break;
        }
      }
      if (names.length > 0) {
        const isRange = tokens[index + 1]?.text === "range";
        let end = statement.end;
        const enclosingClose = context.matchingBracket.get(context.enclosingBracket[index]);
        for (let cursor = index + 1; cursor < statement.end; cursor += 1) {
          if (cursor === enclosingClose) {
            end = cursor;
            break;
          }
          if ((tokens[cursor].text === "{" || tokens[cursor].text === ";") && context.enclosingBracket[cursor] === context.enclosingBracket[index]) {
            end = cursor;
            break;
          }
        }
        add(statement, names, isRange ? "loop-variable" : "declaration", index + (isRange ? 2 : 1), end);
      }
    }

    if (token.kind === "keyword" && (token.text === "var" || token.text === "const") && tokens[index + 1]?.kind === "identifier") {
      const equals = findToken(tokens, index + 2, statement.end, (candidate) => candidate.text === "=");
      add(statement, [index + 1], "declaration", equals === -1 ? statement.end : equals + 1, statement.end);
    }
  }

  plainReassignment(context, statement, add);
}

function rustAssignments(context: FileContext, statement: Statement, add: AddAssignment): void {
  const { tokens } = context;

  for (let index = statement.first; index < statement.end; index += 1) {
    const token = tokens[index];

    if (token.kind === "keyword" && token.text === "let") {
      const equals = findToken(tokens, index + 1, statement.end, (candidate, position) => candidate.text === "=" && context.enclosingBracket[position] === context.enclosingBracket[index]);
      const patternEnd = findToken(tokens, index + 1, equals === -1 ? statement.end : equals, (candidate, position) => candidate.text === ":" && context.enclosingBracket[position] === context.enclosingBracket[index]);
      const end = patternEnd !== -1 ? patternEnd : equals === -1 ? statement.end : equals;
      const names: number[] = [];
      for (let cursor = index + 1; cursor < end; cursor += 1) {
        const candidate = tokens[cursor];
        if (candidate.kind === "identifier" && tokens[cursor + 1]?.text !== "(" && tokens[cursor + 1]?.text !== "::" && tokens[cursor - 1]?.text !== "::") {
          names.push(cursor);
        }
      }
      if (names.length > 0) {
        if (equals === -1) {
          add(statement, names, "declaration", end, end);
        } else {
          add(statement, names, "declaration", equals + 1, expressionEnd(context, equals + 1, statement.end));
        }
      }
    }

    if (token.kind === "keyword" && token.text === "for") {
      const inIndex = findToken(tokens, index + 1, statement.end, (candidate) => candidate.text === "in" && candidate.kind === "keyword");
      if (inIndex !== -1) {
        const names = targetNames(context, index + 1, inIndex);
        const brace = findToken(tokens, inIndex + 1, statement.end, (candidate) => candidate.text === "{");
        if (names) {
          add(statement, names, "loop-variable", inIndex + 1, brace === -1 ? statement.end : brace);
        }
      }
    }
  }

  plainReassignment(context, statement, add);
}

function typedAssignments(context: FileContext, statement: Statement, add: AddAssignment): void {
  const { tokens } = context;
  if (["using", "import", "package", "#", "typedef", "namespace"].includes(tokens[statement.first].text)) {
    return;
  }
  const notTypes = new Set(["return", "new", "throw", "else", "case", "goto", "delete", "await", "in", "is", "as"]);

  for (let index = statement.first + 1; index < statement.end; index += 1) {
    const token = tokens[index];
    const name = tokens[index - 1];
    const before = tokens[index - 2];

    const startsHere = index - 1 === statement.first || (before !== undefined && ["(", ";", "{", "}"].includes(before.text));
    const typed =
      before !== undefined &&
      index - 2 >= statement.first &&
      (((before.kind === "identifier" || before.kind === "keyword") && !notTypes.has(before.text)) || [">", "]", "*", "&"].includes(before.text));

    if (token.text === "=" && name.kind === "identifier") {
      if (typed) {
        add(statement, [index - 1], "declaration", index + 1, expressionEnd(context, index + 1, statement.end));
      } else if (startsHere) {
        add(statement, [index - 1], "assignment", index + 1, expressionEnd(context, index + 1, statement.end));
      }
    } else if (UPDATE_OPERATORS.has(token.text) && name.kind === "identifier" && startsHere) {
      add(statement, [index - 1], "update", index + 1, expressionEnd(context, index + 1, statement.end));
    } else if ((token.text === ":" || token.text === "in") && name.kind === "identifier" && typed) {
      // for (String item : items) / foreach (var item in items)
      const paren = context.enclosingBracket[index];
      const header = paren === -1 ? undefined : tokens[paren - 1];
      if (paren !== -1 && header && (header.text === "for" || header.text === "foreach")) {
        add(statement, [index - 1], "loop-variable", index + 1, context.matchingBracket.get(paren) ?? statement.end);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Occurrences
// ---------------------------------------------------------------------------

export interface OccurrenceSearch {
  readonly occurrences: readonly Occurrence[];
  /** Total found before the limit was applied. */
  readonly total: number;
  readonly limited: boolean;
}

/**
 * Finds where a name is written in the analysed code, ignoring strings
 * and comments. Matching spelling is NOT proof that two occurrences are
 * the same variable; callers must present it as a name match.
 */
export function findOccurrences(context: FileContext, name: string, limit = 400): OccurrenceSearch {
  const { tokens, profile } = context;
  const occurrences: Occurrence[] = [];
  let total = 0;

  const introductionKeys = new Set<string>();
  const key = (range: SourceRange): string => `${range.start.line}:${range.start.character}`;
  context.imports.filter((entry) => entry.localName === name).forEach((entry) => introductionKeys.add(key(entry.nameRange)));
  context.declarations.filter((entry) => entry.name === name).forEach((entry) => introductionKeys.add(key(entry.nameRange)));
  context.assignments.filter((entry) => entry.name === name).forEach((entry) => introductionKeys.add(key(entry.nameRange)));

  tokens.forEach((token, index) => {
    if (token.text !== name || (token.kind !== "identifier" && token.kind !== "keyword")) {
      return;
    }
    total += 1;
    if (occurrences.length >= limit) {
      return;
    }

    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    const range = tokenRange(context, token);
    const bracket = context.enclosingBracket[index];
    let role: OccurrenceRole = "use";
    let memberName: string | undefined;
    let ownerName: string | undefined;
    let memberIsCalled: boolean | undefined;

    if (previous && profile.memberOperators.includes(previous.text) && previous.line === token.line) {
      role = "member";
      const owner = tokens[index - 2];
      ownerName = owner && isName(owner) ? owner.text : undefined;
    } else if (introductionKeys.has(key(range))) {
      role = "introduction";
    } else if (
      profile.family === "python" &&
      next?.text === "=" &&
      bracket !== -1 &&
      tokens[bracket].text === "(" &&
      previous !== undefined &&
      (previous.text === "(" || previous.text === ",")
    ) {
      role = "keyword-argument";
    } else if (
      profile.family === "javascript" &&
      next?.text === ":" &&
      bracket !== -1 &&
      tokens[bracket].text === "{" &&
      previous !== undefined &&
      (previous.text === "{" || previous.text === ",")
    ) {
      role = "property-key";
    } else if (next?.text === "(") {
      role = "call";
    } else if (next && profile.memberOperators.includes(next.text) && isName(tokens[index + 2])) {
      role = "member-root";
      memberName = tokens[index + 2].text;
      memberIsCalled = tokens[index + 3]?.text === "(";
    }

    occurrences.push({
      range,
      line: token.line,
      lineText: context.lines.lineText(token.line),
      role,
      memberName,
      ownerName,
      memberIsCalled,
    });
  });

  return { occurrences, total, limited: total > occurrences.length };
}

/** The statement that contains a given offset, if any. */
export function statementAt(context: FileContext, offset: number): Statement | undefined {
  const { tokens, statements } = context;
  let fallback: Statement | undefined;

  for (const statement of statements) {
    const start = tokens[statement.first].start;
    const end = tokens[statement.end - 1].end;
    if (offset >= start && offset <= end) {
      return statement;
    }
    if (start <= offset) {
      fallback = statement;
    }
  }

  const line = context.lines.positionAt(offset).line;
  return fallback && fallback.endLine >= line ? fallback : undefined;
}

/** Index of the token containing the offset, or -1. */
export function tokenIndexAt(context: FileContext, offset: number): number {
  const { tokens } = context;
  let low = 0;
  let high = tokens.length - 1;

  while (low <= high) {
    const middle = (low + high) >> 1;
    const token = tokens[middle];
    if (offset < token.start) {
      high = middle - 1;
    } else if (offset > token.end) {
      low = middle + 1;
    } else {
      // Prefer a name when the offset sits exactly between two tokens.
      const next = tokens[middle + 1];
      if (offset === token.end && next && next.start === offset && isName(next) && !isName(token)) {
        return middle + 1;
      }
      return middle;
    }
  }

  return -1;
}
