/**
 * A small, language-aware tokenizer.
 *
 * It splits source text into names, keywords, numbers, strings,
 * comments, operators and punctuation. It is not a full parser. Its
 * job is to let Nexus tell real code apart from text inside strings
 * and comments, and to give later steps reliable building blocks.
 */
import type { LanguageProfile } from "./languageProfiles";

export type TokenKind =
  | "identifier"
  | "keyword"
  | "number"
  | "string"
  | "comment"
  | "operator"
  | "punct";

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  /** Character offset of the first character in the analysed text. */
  readonly start: number;
  /** Character offset just past the last character. */
  readonly end: number;
  /** Zero-based line of the first character. */
  readonly line: number;
  /** Zero-based column of the first character. */
  readonly column: number;
}

const OPERATORS = [
  ">>>=", "...", "===", "!==", "**=", "//=", ">>=", "<<=", "&&=", "||=", "??=",
  "=>", "->", "::", "?.", "==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "%=",
  "&&", "||", "??", ":=", "**", "++", "--", "<<", ">>", "|=", "&=", "^=", "<-",
];

const PUNCTUATION = new Set(["(", ")", "[", "]", "{", "}", ",", ";", ":"]);

/** Words that are keywords only in some positions. */
const SOFT_KEYWORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  javascript: new Set(["type", "of", "from", "as", "readonly", "async", "static", "in", "enum", "interface", "default", "delete", "void", "super", "yield", "implements"]),
  java: new Set(["record", "var"]),
  c: new Set(["include", "define", "using", "namespace"]),
  csharp: new Set(["var", "string"]),
  go: new Set(["map"]),
  python: new Set(["self"]),
  rust: new Set([]),
  generic: new Set([]),
};

const IDENTIFIER_START = /[\p{L}_$]/u;
const IDENTIFIER_PART = /[\p{L}\p{N}_$]/u;

export interface TokenizeOptions {
  /** Offset in the full document where `text` starts. */
  readonly baseOffset?: number;
  /** Line number in the full document where `text` starts. */
  readonly baseLine?: number;
  /** Column in the full document where `text` starts. */
  readonly baseColumn?: number;
}

export function tokenize(
  text: string,
  profile: LanguageProfile,
  options: TokenizeOptions = {},
): Token[] {
  const tokens: Token[] = [];
  const baseOffset = options.baseOffset ?? 0;
  let line = options.baseLine ?? 0;
  let lineStart = -(options.baseColumn ?? 0);
  let index = 0;

  const push = (kind: TokenKind, start: number, end: number): void => {
    tokens.push({
      kind,
      text: text.slice(start, end),
      start: baseOffset + start,
      end: baseOffset + end,
      line,
      column: start - lineStart,
    });

    // Multi-line tokens (block comments, triple-quoted strings) advance the line counter.
    for (let cursor = start; cursor < end; cursor += 1) {
      if (text.charCodeAt(cursor) === 10) {
        line += 1;
        lineStart = cursor + 1;
      }
    }
  };

  while (index < text.length) {
    const character = text[index];

    if (character === "\n") {
      line += 1;
      lineStart = index + 1;
      index += 1;
      continue;
    }

    if (character === " " || character === "\t" || character === "\r" || character === "\f") {
      index += 1;
      continue;
    }

    const lineComment = profile.lineComments.find((marker) => text.startsWith(marker, index));
    if (lineComment && !(profile.family === "c" && lineComment === "#")) {
      const end = indexOfOrEnd(text, "\n", index);
      push("comment", index, end);
      index = end;
      continue;
    }

    if (profile.blockComment && text.startsWith(profile.blockComment[0], index)) {
      const close = text.indexOf(profile.blockComment[1], index + profile.blockComment[0].length);
      const end = close === -1 ? text.length : close + profile.blockComment[1].length;
      push("comment", index, end);
      index = end;
      continue;
    }

    const stringEnd = readString(text, index, profile);
    if (stringEnd !== undefined) {
      push("string", index, stringEnd);
      index = stringEnd;
      continue;
    }

    if (character >= "0" && character <= "9") {
      let end = index + 1;
      while (end < text.length) {
        const next = text[end];
        if (/[A-Za-z0-9_]/.test(next)) {
          end += 1;
        } else if (next === "." && /[0-9]/.test(text[end + 1] ?? "")) {
          end += 1;
        } else {
          break;
        }
      }
      push("number", index, end);
      index = end;
      continue;
    }

    if (IDENTIFIER_START.test(character)) {
      let end = index + 1;
      while (end < text.length && IDENTIFIER_PART.test(text[end])) {
        end += 1;
      }
      push("identifier", index, end);
      index = end;
      continue;
    }

    if (PUNCTUATION.has(character) && !text.startsWith("::", index) && !text.startsWith(":=", index)) {
      push("punct", index, index + 1);
      index += 1;
      continue;
    }

    const operator = OPERATORS.find((candidate) => text.startsWith(candidate, index));
    const end = index + (operator ? operator.length : 1);
    push("operator", index, end);
    index = end;
  }

  return markKeywords(tokens, profile);
}

function readString(text: string, index: number, profile: LanguageProfile): number | undefined {
  let quoteIndex = index;

  // Optional prefix such as Python's f"..." or C#'s $"...".
  while (
    quoteIndex < index + 3 &&
    quoteIndex < text.length &&
    profile.stringPrefixLetters.includes(text[quoteIndex]) &&
    text[quoteIndex] !== '"' &&
    text[quoteIndex] !== "'"
  ) {
    quoteIndex += 1;
  }

  const quote = text[quoteIndex];
  if (quote !== '"' && quote !== "'" && quote !== "`") {
    return undefined;
  }

  if (quoteIndex > index && index > 0 && IDENTIFIER_PART.test(text[index - 1])) {
    return undefined;
  }

  if (quote === "`") {
    if (!profile.backtickStrings) {
      return undefined;
    }
    return closeQuote(text, quoteIndex + 1, "`", true, profile.family !== "go");
  }

  if (quote === "'" && !profile.singleQuoteStrings) {
    // Rust: 'a' is a character, 'a is a lifetime.
    const match = /^'(\\.[^']*|[^\\'])'/.exec(text.slice(quoteIndex, quoteIndex + 12));
    return match ? quoteIndex + match[0].length : undefined;
  }

  const triple = quote.repeat(3);
  if (profile.tripleQuotedStrings && text.startsWith(triple, quoteIndex)) {
    const close = text.indexOf(triple, quoteIndex + 3);
    return close === -1 ? text.length : close + 3;
  }

  return closeQuote(text, quoteIndex + 1, quote, false, true);
}

function closeQuote(
  text: string,
  from: number,
  quote: string,
  multiline: boolean,
  escapes: boolean,
): number {
  let index = from;

  while (index < text.length) {
    const character = text[index];
    if (escapes && character === "\\") {
      index += 2;
      continue;
    }
    if (character === quote) {
      return index + 1;
    }
    if (character === "\n" && !multiline) {
      return index;
    }
    index += 1;
  }

  return text.length;
}

function markKeywords(tokens: Token[], profile: LanguageProfile): Token[] {
  const softKeywords = SOFT_KEYWORDS[profile.family] ?? new Set<string>();
  const code = tokens.filter((token) => token.kind !== "comment");
  const positionInCode = new Map<Token, number>();
  code.forEach((token, position) => positionInCode.set(token, position));

  return tokens.map((token) => {
    if (token.kind !== "identifier" || !Object.hasOwn(profile.keywords, token.text)) {
      return token;
    }

    const position = positionInCode.get(token) ?? 0;
    const previous = code[position - 1];
    const next = code[position + 1];

    if (previous && profile.memberOperators.includes(previous.text)) {
      return token;
    }

    if (softKeywords.has(token.text) && !softKeywordApplies(token, previous, next, profile)) {
      return token;
    }

    return { ...token, kind: "keyword" as const };
  });
}

function softKeywordApplies(
  token: Token,
  previous: Token | undefined,
  next: Token | undefined,
  profile: LanguageProfile,
): boolean {
  if (profile.family === "python") {
    // `self` is a convention, not a keyword, but it is worth explaining wherever it appears.
    return true;
  }

  if (profile.family === "c" && (token.text === "include" || token.text === "define")) {
    return previous?.text === "#";
  }

  if (!next) {
    return false;
  }

  // A soft keyword used as an ordinary name is followed by code that treats it as a value.
  if (["(", "=", ".", ",", ")", ";", "]", "[", "?.", "=>"].includes(next.text)) {
    return false;
  }

  if (next.text === ":" && token.text !== "default") {
    return false;
  }

  return true;
}

function indexOfOrEnd(text: string, search: string, from: number): number {
  const found = text.indexOf(search, from);
  return found === -1 ? text.length : found;
}

/** Reads the text content of a string token without its quotes or prefix. */
export function stringContent(tokenText: string): string {
  const match = /^[A-Za-z@$]{0,3}("""|'''|"|'|`)/.exec(tokenText);
  if (!match) {
    return tokenText;
  }

  const quote = match[1];
  const body = tokenText.slice(match[0].length);
  return body.endsWith(quote) ? body.slice(0, body.length - quote.length) : body;
}
