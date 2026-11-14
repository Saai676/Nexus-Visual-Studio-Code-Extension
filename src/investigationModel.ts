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
