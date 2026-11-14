export type InvestigationStatus =
  | "completed"
  | "partial"
  | "unavailable"
  | "failed";

export type ProviderResultStatus =
  | "returned"
  | "no-results"
  | "unavailable"
  | "failed";

export type EvidenceRelationship = "definition" | "reference";

export interface SourcePosition {
  readonly line: number;
  readonly character: number;
}

export interface SourceRange {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

export interface EvidenceLocation {
  readonly relationship: EvidenceRelationship;
  readonly uri: string;
  readonly range: SourceRange;
  /** The source line at this location, when Nexus could read it. */
  readonly excerpt?: string;
}

export interface InvestigatedSymbol {
  readonly name: string;
  readonly origin: "selection" | "word";
  readonly sourceUri: string;
  readonly range: SourceRange;
  readonly providerPosition: SourcePosition;
}

export interface ProviderQuery {
  readonly status: ProviderResultStatus;
  readonly returnedLocationCount: number;
  readonly ignoredResultCount: number;
  readonly message?: string;
}

export interface SymbolInvestigation {
  readonly symbol: InvestigatedSymbol;
  readonly definitions: readonly EvidenceLocation[];
  readonly references: readonly EvidenceLocation[];
  readonly definitionQuery: ProviderQuery;
  readonly referenceQuery: ProviderQuery;
  readonly status: InvestigationStatus;
  readonly limitations: readonly string[];
  readonly investigatedAt: string;
}

/**
 * Documentation text returned by a language provider's hover request.
 * It is provider-reported: Nexus shows it but never treats it as a
 * complete description of how the code behaves.
 */
export interface ProviderDocumentation {
  /** The source text the hover was requested for, e.g. "title". */
  readonly subject: string;
  readonly position: SourcePosition;
  /** Plain text, already bounded in length. */
  readonly text: string;
  /** True when the original hover text was longer than what is kept. */
  readonly truncated: boolean;
}

/** A named region reported by the document-symbol provider. */
export interface ProviderSymbol {
  readonly name: string;
  /** Lower-case kind name such as "function", "class" or "method". */
  readonly kind: string;
  readonly range: SourceRange;
  readonly selectionRange: SourceRange;
}

/**
 * Everything Nexus gathered for one investigation: what the language
 * providers reported, plus the explanation built from the active file.
 */
export interface NexusInvestigation {
  readonly provider: SymbolInvestigation;
  readonly documentation: readonly ProviderDocumentation[];
  readonly languageId: string;
  readonly selectedText: string;
}
