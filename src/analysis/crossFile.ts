/**
 * Cross-file context.
 *
 * Pure helpers that read ANOTHER file's text to describe a declaration
 * the language server pointed at, or to find where a file is imported.
 * They report what is written there, including the author's own
 * docstring or comment. They never guess behaviour.
 */
import { buildFileContext } from "./fileContext";
import { profileFor } from "./languageProfiles";
import { LineIndex, shorten } from "./text";
import { stringContent, tokenize } from "./tokenizer";

export interface DeclarationSummary {
  readonly kind: string;
  readonly name: string;
  readonly header: string;
  readonly parameters: readonly string[];
  /** The author's docstring or the comment directly above, if any. */
  readonly authorNote?: string;
  readonly line: number;
}

/** Describes the declaration found on or just around `line` in another file. */
export function summarizeDeclarationAt(
  text: string,
  languageId: string,
  line: number,
): DeclarationSummary | undefined {
  if (text.length > 800_000) {
    return undefined;
  }
  const profile = profileFor(languageId);
  const lines = new LineIndex(text);
  const context = buildFileContext(text, profile, lines.lineStartOffset(line));
  const declaration = context.declarations.find((candidate) => candidate.line === line);

  let authorNote = commentAbove(text, lines, line, profile.lineComments, profile.blockComment);
  if (declaration && profile.family === "python") {
    authorNote = pythonDocstring(lines, declaration.line, declaration.endLine, languageId) ?? authorNote;
  }

  if (!declaration) {
    const header = lines.lineText(line).trim();
    return header ? { kind: "definition", name: "", header: shorten(header, 120), parameters: [], authorNote, line } : undefined;
  }

  return {
    kind: declaration.kind,
    name: declaration.name,
    header: shorten(declaration.headerText, 120),
    parameters: declaration.parameters.map((parameter) => parameter.name),
    authorNote,
    line,
  };
}

function pythonDocstring(lines: LineIndex, startLine: number, endLine: number, languageId: string): string | undefined {
  const from = lines.lineStartOffset(startLine);
  const to = lines.lineEndOffset(Math.min(endLine, startLine + 40));
  const tokens = tokenize(lines.text.slice(from, to), profileFor(languageId)).filter((token) => token.kind !== "comment");

  // The docstring is the first string that directly follows the header's closing colon.
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (["(", "[", "{"].includes(token.text)) depth += 1;
    if ([")", "]", "}"].includes(token.text)) depth -= 1;
    if (token.text === ":" && depth === 0) {
      const next = tokens[index + 1];
      return next?.kind === "string" ? cleanNote(stringContent(next.text)) : undefined;
    }
  }
  return undefined;
}

function commentAbove(
  text: string,
  lines: LineIndex,
  line: number,
  lineComments: readonly string[],
  blockComment?: readonly [string, string],
): string | undefined {
  const collected: string[] = [];
  let cursor = line - 1;

  // Skip decorators / annotations directly above the declaration.
  while (cursor >= 0 && /^\s*@/.test(lines.lineText(cursor))) {
    cursor -= 1;
  }

  if (blockComment && cursor >= 0 && lines.lineText(cursor).trim().endsWith(blockComment[1])) {
    const end = lines.lineEndOffset(cursor);
    const start = text.lastIndexOf(blockComment[0], end);
    if (start !== -1 && lines.positionAt(start).line >= line - 40) {
      const body = text
        .slice(start + blockComment[0].length, end - blockComment[1].length)
        .split("\n")
        .map((entry) => entry.replace(/^\s*\*+\s?/, "").trim())
        .filter((entry) => entry.length > 0 && !entry.startsWith("@"))
        .join(" ");
      return cleanNote(body);
    }
  }

  while (cursor >= 0 && collected.length < 8) {
    const current = lines.lineText(cursor).trim();
    const marker = lineComments.find((candidate) => current.startsWith(candidate));
    if (!marker) {
      break;
    }
    collected.unshift(current.slice(marker.length).replace(/^[/!]+/, "").trim());
    cursor -= 1;
  }

  return collected.length > 0 ? cleanNote(collected.join(" ")) : undefined;
}

function cleanNote(value: string): string | undefined {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length >= 3 ? shorten(cleaned, 260) : undefined;
}

export interface ImportLine {
  readonly line: number;
  readonly excerpt: string;
}

/**
 * Finds import statements in `text` whose module path ends with one of
 * the given names (e.g. "utils" matches `import utils`, `from app.utils
 * import x` and `import x from "./utils"`). This is a path-name match,
 * not proof that the import resolves to a particular file.
 */
export function findImportsOf(text: string, languageId: string, moduleNames: readonly string[]): ImportLine[] {
  if (text.length > 400_000 || moduleNames.length === 0) {
    return [];
  }
  const context = buildFileContext(text, profileFor(languageId));
  const wanted = new Set(moduleNames);
  const seen = new Set<number>();
  const results: ImportLine[] = [];

  const consider = (module: string, importedName: string, line: number, excerpt: string): void => {
    const withoutExtension = module.replace(/\.(js|ts|jsx|tsx|mjs|cjs|py|h|hpp)$/, "");
    const last = withoutExtension.split(/[./\\:]+/).filter(Boolean).pop() ?? "";
    if ((wanted.has(last) || wanted.has(importedName)) && !seen.has(line)) {
      seen.add(line);
      results.push({ line, excerpt: shorten(excerpt, 140) });
    }
  };

  context.imports.forEach((binding) => consider(binding.module, binding.form === "member" ? binding.importedName : "", binding.line, binding.statementText));
  context.wildcardImports.forEach((entry) => consider(entry.module, "", entry.line, entry.statementText));

  return results;
}
