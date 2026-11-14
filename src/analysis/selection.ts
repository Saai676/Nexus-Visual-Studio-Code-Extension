/**
 * Works out what the developer selected.
 *
 * Given the document text and a selection (or just a cursor), this
 * decides: which token is the focus, which complete expression should
 * be explained, which statement it sits in, and where a name came from
 * according to what is written in the file.
 */
import {
  buildFileContext,
  enclosingDeclaration,
  statementAt,
  tokenIndexAt,
  type Assignment,
  type Declaration,
  type FileContext,
  type ImportBinding,
  type Statement,
} from "./fileContext";
import { profileFor } from "./languageProfiles";
import type { Token } from "./tokenizer";

export interface SelectionInput {
  readonly text: string;
  readonly languageId: string;
  /** Character offsets into `text`. Equal offsets mean "just a cursor". */
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

export type FocusKind = "name" | "member" | "keyword" | "string" | "number" | "symbol";

export interface ChainSegment {
  readonly kind: "member" | "call" | "index";
  /** member: index of the operator token. call/index: index of the opening bracket. */
  readonly open: number;
  /** member: index of the member name token. call/index: index of the closing bracket. */
  readonly close: number;
}

/** A name followed by member accesses, calls and index lookups: `st.columns(2)[0]`. */
export interface Chain {
  readonly root: number;
  readonly segments: readonly ChainSegment[];
  /** Index just past the last token of the chain. */
  readonly end: number;
}

export interface SelectionAnalysis {
  readonly context: FileContext;
  /** Token index of the focus, or -1 when no code was found at the selection. */
  readonly focusIndex: number;
  readonly focusKind: FocusKind;
  /** Token span [first, end) of the expression to explain. */
  readonly expressionFirst: number;
  readonly expressionEnd: number;
  readonly expressionText: string;
  readonly statement?: Statement;
  /** The chain the focus belongs to, when it is part of one. */
  readonly chain?: Chain;
  /** Token indexes where provider documentation is worth requesting. */
  readonly documentationTargets: readonly number[];
  /** True when the user selected more than one token. */
  readonly multiTokenSelection: boolean;
}

export function analyzeSelection(input: SelectionInput): SelectionAnalysis {
  const profile = profileFor(input.languageId);
  const context = buildFileContext(input.text, profile, input.selectionStart);
  const { tokens } = context;

  const [rawStart, rawEnd] = trimSelection(input);
  let first = -1;
  let end = -1;

  if (rawEnd > rawStart) {
    tokens.forEach((token, index) => {
      if (token.end > rawStart && token.start < rawEnd) {
        if (first === -1) {
          first = index;
        }
        end = index + 1;
      }
    });
  }

  if (first === -1) {
    const index = tokenIndexAt(context, rawStart);
    if (index === -1) {
      return emptyAnalysis(context);
    }
    first = index;
    end = index + 1;
  }

  const multiTokenSelection = end - first > 1;
  const focusIndex = multiTokenSelection ? chooseFocus(context, first, end) : first;
  const focusKind = classifyFocus(context, focusIndex);
  const statement = statementAt(context, tokens[focusIndex].start);

  let chain: Chain | undefined;
  if (focusKind === "name" || focusKind === "member") {
    chain = parseChain(context, chainRoot(context, focusIndex));
    if (!multiTokenSelection && chain.segments.length > 0) {
      first = chain.root;
      end = chain.end;
    }
  }

  const documentationTargets = [focusIndex];
  if (chain) {
    const callee = calleeIndex(chain);
    if (callee !== undefined && callee !== focusIndex) {
      documentationTargets.push(callee);
    }
  }

  return {
    context,
    focusIndex,
    focusKind,
    expressionFirst: first,
    expressionEnd: end,
    expressionText: input.text.slice(tokens[first].start, tokens[end - 1].end),
    statement,
    chain,
    documentationTargets,
    multiTokenSelection,
  };
}

function trimSelection(input: SelectionInput): [number, number] {
  let start = Math.max(0, Math.min(input.selectionStart, input.selectionEnd));
  let end = Math.min(input.text.length, Math.max(input.selectionStart, input.selectionEnd));

  while (start < end && /\s/.test(input.text[start])) {
    start += 1;
  }
  while (end > start && /\s/.test(input.text[end - 1])) {
    end -= 1;
  }

  return [start, end];
}

function emptyAnalysis(context: FileContext): SelectionAnalysis {
  return {
    context,
    focusIndex: -1,
    focusKind: "symbol",
    expressionFirst: 0,
    expressionEnd: 0,
    expressionText: "",
    documentationTargets: [],
    multiTokenSelection: false,
  };
}

/** For a multi-token selection, picks the token the language providers should be asked about. */
function chooseFocus(context: FileContext, first: number, end: number): number {
  const { tokens, profile } = context;

  // An import statement: focus the name the import makes available.
  for (const binding of context.imports) {
    for (let index = first; index < end; index += 1) {
      const token = tokens[index];
      const position = context.lines.positionAt(token.start);
      if (
        position.line === binding.nameRange.start.line &&
        position.character === binding.nameRange.start.character &&
        token.kind !== "string"
      ) {
        return index;
      }
    }
  }

  // A declaration header such as `def name(...)`: focus the declared name.
  for (let index = first; index < end - 1; index += 1) {
    if (tokens[index].kind === "keyword" && ["def", "class", "function", "fn", "func", "interface", "struct", "enum", "trait"].includes(tokens[index].text) && tokens[index + 1].kind === "identifier") {
      return index + 1;
    }
  }

  for (let index = first; index < end; index += 1) {
    const previous = tokens[index - 1];
    if (tokens[index].kind === "identifier" && !(previous && index - 1 >= first && profile.memberOperators.includes(previous.text))) {
      return index;
    }
  }

  for (let index = first; index < end; index += 1) {
    if (tokens[index].kind === "identifier" || tokens[index].kind === "keyword") {
      return index;
    }
  }

  return first;
}

function classifyFocus(context: FileContext, index: number): FocusKind {
  const { tokens, profile } = context;
  const token = tokens[index];
  const previous = tokens[index - 1];

  switch (token.kind) {
    case "keyword":
      return "keyword";
    case "string":
      return "string";
    case "number":
      return "number";
    case "identifier":
      return previous && profile.memberOperators.includes(previous.text) && previous.line === token.line
        ? "member"
        : "name";
    default:
      return "symbol";
  }
}

/** Walks left from a name through `owner.` pairs to the first name of the chain. */
function chainRoot(context: FileContext, index: number): number {
  const { tokens, profile } = context;
  let root = index;

  while (root >= 2) {
    const operator = tokens[root - 1];
    const owner = tokens[root - 2];
    if (!profile.memberOperators.includes(operator.text)) {
      break;
    }
    if (owner.kind === "identifier" || owner.kind === "keyword") {
      root -= 2;
      continue;
    }
    // `foo(1).bar` or `items[0].name`: step over the bracket pair to the name before it.
    if (owner.text === ")" || owner.text === "]") {
      const open = findOpening(context, root - 2);
      const before = open === undefined ? undefined : tokens[open - 1];
      if (open !== undefined && before && (before.kind === "identifier" || before.kind === "keyword")) {
        root = open - 1;
        continue;
      }
    }
    break;
  }

  return root;
}

function findOpening(context: FileContext, closeIndex: number): number | undefined {
  for (const [open, close] of context.matchingBracket) {
    if (close === closeIndex) {
      return open;
    }
  }
  return undefined;
}

export function parseChain(context: FileContext, root: number): Chain {
  const { tokens, profile } = context;
  const segments: ChainSegment[] = [];
  let index = root + 1;

  while (index < tokens.length) {
    const token = tokens[index];
    const previous = tokens[index - 1];

    if (profile.memberOperators.includes(token.text) && tokens[index + 1] && (tokens[index + 1].kind === "identifier" || tokens[index + 1].kind === "keyword")) {
      segments.push({ kind: "member", open: index, close: index + 1 });
      index += 2;
      continue;
    }

    // Rust macros: println!(...)
    if (token.text === "!" && profile.family === "rust" && tokens[index + 1]?.text === "(") {
      index += 1;
      continue;
    }

    if ((token.text === "(" || token.text === "[") && token.start === previous.end) {
      const close = context.matchingBracket.get(index);
      if (close === undefined) {
        break;
      }
      segments.push({ kind: token.text === "(" ? "call" : "index", open: index, close });
      index = close + 1;
      continue;
    }

    // Allow `foo (x)` with a space only for calls, and only on the same line.
    if (token.text === "(" && token.line === previous.line && profile.family !== "python" && previous.kind === "identifier") {
      const close = context.matchingBracket.get(index);
      if (close === undefined) {
        break;
      }
      segments.push({ kind: "call", open: index, close });
      index = close + 1;
      continue;
    }

    break;
  }

  return { root, segments, end: index };
}

/** The name that is actually being called in a chain: `st.title(...)` -> `title`. */
export function calleeIndex(chain: Chain): number | undefined {
  for (let position = chain.segments.length - 1; position >= 0; position -= 1) {
    if (chain.segments[position].kind === "call") {
      const before = chain.segments[position - 1];
      if (!before) {
        return chain.root;
      }
      return before.kind === "member" ? before.close : undefined;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Where a name comes from, according to this file
// ---------------------------------------------------------------------------

export type NameOrigin =
  | { readonly kind: "import"; readonly binding: ImportBinding }
  | { readonly kind: "declaration"; readonly declaration: Declaration }
  | {
      readonly kind: "assignment";
      readonly assignment: Assignment;
      /** Every place in the visible scopes that gives this name a value. */
      readonly all: readonly Assignment[];
    }
  | { readonly kind: "builtin"; readonly description: string }
  | { readonly kind: "unknown" };

/**
 * Finds the closest place the file introduces a name, looking from the
 * innermost enclosing function or class outwards to file level.
 *
 * This reflects what is WRITTEN. It is a careful reading of the file,
 * not a guarantee about which value the name holds at runtime.
 */
export function resolveName(context: FileContext, name: string, line: number): NameOrigin {
  const scopes: number[] = [];
  let scope = enclosingDeclaration(context.declarations, line);
  while (scope !== -1) {
    scopes.push(scope);
    scope = context.declarations[scope].parent;
  }
  scopes.push(-1);

  const visibleAssignments = context.assignments.filter(
    (assignment) => assignment.name === name && scopes.includes(assignment.scope),
  );

  // A declaration whose own name line is the queried line always wins (cursor on `def foo`).
  const declaredHere = context.declarations.find(
    (declaration) => declaration.name === name && declaration.line === line,
  );
  if (declaredHere) {
    return { kind: "declaration", declaration: declaredHere };
  }

  for (const current of scopes) {
    const inScope = visibleAssignments.filter((assignment) => assignment.scope === current);
    if (inScope.length > 0) {
      const earlier = inScope.filter((assignment) => assignment.line <= line);
      const chosen = earlier.length > 0 ? earlier[earlier.length - 1] : inScope[0];
      const importHere = context.imports.find(
        (binding) => binding.localName === name && binding.line === chosen.line,
      );
      if (!importHere) {
        return { kind: "assignment", assignment: chosen, all: visibleAssignments };
      }
    }

    const declaration = context.declarations.find(
      (candidate) => candidate.name === name && candidate.parent === current,
    );
    if (declaration) {
      return { kind: "declaration", declaration };
    }

    const binding = context.imports.find(
      (candidate) =>
        candidate.localName === name &&
        enclosingDeclaration(context.declarations, candidate.line) === current,
    );
    if (binding) {
      return { kind: "import", binding };
    }
  }

  const anyDeclaration = context.declarations.find((candidate) => candidate.name === name);
  if (anyDeclaration) {
    return { kind: "declaration", declaration: anyDeclaration };
  }

  if (Object.hasOwn(context.profile.builtins, name)) {
    return { kind: "builtin", description: context.profile.builtins[name] };
  }

  return { kind: "unknown" };
}

// ---------------------------------------------------------------------------
// Blocks that belong to a statement (for if/then flow)
// ---------------------------------------------------------------------------

export interface Block {
  readonly startLine: number;
  readonly endLine: number;
}

/** The block of code controlled by a header statement such as `if x:` or `for (...) {`. */
export function blockOf(context: FileContext, header: Statement): Block | undefined {
  const { tokens, statements } = context;
  const position = statements.indexOf(header);

  if (context.profile.blockStyle === "indent") {
    let startLine: number | undefined;
    let endLine = header.endLine;
    for (let index = position + 1; index < statements.length; index += 1) {
      if (statements[index].indent <= header.indent) {
        break;
      }
      startLine ??= statements[index].startLine;
      endLine = statements[index].endLine;
    }
    return startLine === undefined ? undefined : { startLine, endLine };
  }

  const level = context.enclosingBracket[header.first];
  for (let index = header.first; index < header.end; index += 1) {
    if (tokens[index].text === "{" && context.enclosingBracket[index] === level) {
      const close = context.matchingBracket.get(index);
      if (close === undefined) {
        return undefined;
      }
      const openLine = tokens[index].line;
      const closeLine = tokens[close].line;
      if (closeLine - openLine >= 2) {
        return { startLine: openLine + 1, endLine: closeLine - 1 };
      }
      return { startLine: openLine, endLine: closeLine };
    }
  }

  const next = statements[position + 1];
  return next && tokens[next.first].text !== "{" ? undefined : next ? blockOf(context, next) : undefined;
}

/** The next statement at the same level, when it starts with one of the given keywords. */
export function followingBranch(
  context: FileContext,
  header: Statement,
  keywords: readonly string[],
): Statement | undefined {
  const { tokens, statements } = context;
  const position = statements.indexOf(header);

  if (context.profile.blockStyle === "indent") {
    for (let index = position + 1; index < statements.length; index += 1) {
      const candidate = statements[index];
      if (candidate.indent > header.indent) {
        continue;
      }
      return candidate.indent === header.indent && keywords.includes(tokens[candidate.first].text)
        ? candidate
        : undefined;
    }
    return undefined;
  }

  const block = blockOf(context, header);
  if (!block) {
    return undefined;
  }
  return statements.find((candidate) => {
    if (candidate === header || candidate.startLine < block.endLine || candidate.startLine > block.endLine + 1) {
      return false;
    }
    const firstToken = tokens[candidate.first];
    const second = tokens[candidate.first + 1];
    return keywords.includes(firstToken.text) || (firstToken.text === "}" && second !== undefined && keywords.includes(second.text));
  });
}

/** Text of the tokens [first, end) exactly as written in the file. */
export function sourceText(context: FileContext, first: number, end: number): string {
  if (end <= first) {
    return "";
  }
  return context.lines.text
    .slice(context.tokens[first].start, context.tokens[end - 1].end)
    .replace(/\s*\n\s*/g, " ");
}

export type { Token };
