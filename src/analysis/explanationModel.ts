/**
 * The explanation Nexus shows for one investigation.
 *
 * This is plain data: the builder fills it in and the panel renders it.
 * Every repository-specific statement carries a `basis` saying what
 * kind of evidence supports it, and the ids of the evidence items a
 * reader can click to check it.
 */
import type { SourceRange } from "../investigationModel";

/**
 * source:     read directly in the file, with an exact location.
 * provider:   reported by a VS Code language provider (language server).
 * language:   a general rule of the programming language.
 * name-match: the same spelling was found; NOT proof it is the same thing.
 */
export type Basis = "source" | "provider" | "language" | "name-match";

export interface CodeSpan {
  readonly code: string;
}

/** Text made of plain parts and inline code parts. */
export type Rich = readonly (string | CodeSpan)[];

export interface Evidence {
  readonly id: string;
  readonly basis: Basis;
  /** What this location shows, e.g. "Import statement". */
  readonly label: string;
  readonly uri: string;
  readonly range: SourceRange;
  /** The source line, trimmed. Empty when the text could not be read. */
  readonly excerpt: string;
}

export interface Claim {
  readonly text: Rich;
  readonly basis: Basis;
  readonly evidenceIds: readonly string[];
}

export type PartRole =
  | "name"
  | "member"
  | "keyword"
  | "text"
  | "number"
  | "access"
  | "call"
  | "operator"
  | "plain";

export interface BreakdownPart {
  readonly text: string;
  readonly role: PartRole;
  /** Short caption under the piece. Empty for punctuation that needs none. */
  readonly label: string;
  /** One-sentence explanation shown in the legend. */
  readonly detail?: Rich;
  /** True for the piece the investigation is about. */
  readonly focus: boolean;
}

export type MapColumn = "origin" | "focus" | "usage";

export interface MapNode {
  readonly id: string;
  readonly column: MapColumn;
  /** Small text describing the relationship, e.g. "imported from". */
  readonly caption: string;
  readonly label: string;
  readonly basis: Basis;
  readonly evidenceId?: string;
  /** Render the label as code. */
  readonly code: boolean;
}

export interface ConceptMap {
  readonly nodes: readonly MapNode[];
}

export interface FlowRow {
  readonly tag: string;
  readonly text: Rich;
  /** then: a normal step. else: the alternative path. note: a reminder. */
  readonly tone: "if" | "then" | "else" | "note";
}

export interface Flow {
  readonly title: string;
  readonly rows: readonly FlowRow[];
}

export interface WhatIf {
  readonly change: Rich;
  readonly effect: Rich;
  readonly basis: Basis;
  readonly evidenceIds: readonly string[];
}

export interface DocumentationNote {
  readonly subject: string;
  readonly text: string;
  readonly truncated: boolean;
}

export interface GlossaryEntry {
  readonly term: string;
  readonly plain: string;
}

export interface ProviderStatusLine {
  readonly label: string;
  readonly status: string;
  readonly count: number;
  readonly message?: string;
}

export interface Explanation {
  /** False when no code was found at the selection. */
  readonly hasContent: boolean;
  readonly emptyMessage?: string;
  /** The code being explained, as written. */
  readonly heading: string;
  /** e.g. "Import alias", "Function", "Variable". */
  readonly kindLabel: string;
  readonly languageLabel: string;
  readonly supportLevel: "detailed" | "basic" | "generic";
  readonly supportNote: string;
  readonly uri: string;
  readonly range: SourceRange;
  readonly meaning: readonly Claim[];
  readonly breakdown: readonly BreakdownPart[];
  readonly breakdownTruncated: boolean;
  readonly fits: readonly Claim[];
  /** What the rest of the project shows about it (other files). */
  readonly project: readonly Claim[];
  readonly map: ConceptMap;
  readonly flow?: Flow;
  readonly whatIf: readonly WhatIf[];
  readonly documentation: readonly DocumentationNote[];
  readonly unknowns: readonly Rich[];
  readonly evidence: readonly Evidence[];
  readonly glossary: readonly GlossaryEntry[];
  readonly limits: readonly string[];
  readonly providerStatus: readonly ProviderStatusLine[];
}

export const c = (code: string): CodeSpan => ({ code });

/** Tagged template for rich text: r`${c("st")} is an alias`. */
export function r(
  strings: TemplateStringsArray,
  ...values: readonly (string | number | CodeSpan | Rich)[]
): Rich {
  const parts: (string | CodeSpan)[] = [];

  strings.forEach((text, index) => {
    if (text) {
      parts.push(text);
    }
    if (index < values.length) {
      const value = values[index];
      if (Array.isArray(value)) {
        parts.push(...(value as Rich));
      } else if (typeof value === "object") {
        parts.push(value as CodeSpan);
      } else {
        parts.push(String(value));
      }
    }
  });

  return parts;
}

export function richToPlain(rich: Rich): string {
  return rich.map((part) => (typeof part === "string" ? part : part.code)).join("");
}
