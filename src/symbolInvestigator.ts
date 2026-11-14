import * as vscode from "vscode";
import {
  type EvidenceLocation,
  type EvidenceRelationship,
  type InvestigationStatus,
  type InvestigatedSymbol,
  type ProviderQuery,
  type ProviderResultStatus,
  type SourceRange,
  type SymbolInvestigation,
} from "./investigationModel";

interface ProviderQueryResult {
  readonly query: ProviderQuery;
  readonly locations: readonly EvidenceLocation[];
}

export async function investigateSymbol(
  document: vscode.TextDocument,
  symbol: InvestigatedSymbol,
): Promise<SymbolInvestigation> {
  const position = new vscode.Position(
    symbol.providerPosition.line,
    symbol.providerPosition.character,
  );
  const [definitionResult, referenceResult] = await Promise.all([
    requestLocations(
      "vscode.executeDefinitionProvider",
      [document.uri, position],
      "definition",
    ),
    requestLocations(
      "vscode.executeReferenceProvider",
      [document.uri, position, true],
      "reference",
    ),
  ]);

  return {
    symbol,
    definitions: definitionResult.locations,
    references: referenceResult.locations,
    definitionQuery: definitionResult.query,
    referenceQuery: referenceResult.query,
    status: determineInvestigationStatus(
      definitionResult.query.status,
      referenceResult.query.status,
    ),
    limitations: createLimitations(definitionResult.query, referenceResult.query),
    investigatedAt: new Date().toISOString(),
  };
}

async function requestLocations(
  command: "vscode.executeDefinitionProvider" | "vscode.executeReferenceProvider",
  argumentsForCommand: readonly unknown[],
  relationship: EvidenceRelationship,
): Promise<ProviderQueryResult> {
  try {
    const response = await vscode.commands.executeCommand<unknown>(
      command,
      ...argumentsForCommand,
    );

    if (response === undefined || response === null) {
      return {
        locations: [],
        query: {
          status: "no-results",
          returnedLocationCount: 0,
          ignoredResultCount: 0,
          message:
            "The provider command completed without returning locations. This may mean no result was found or no provider supplied a result; Nexus cannot distinguish those cases from this response.",
        },
      };
    }

    const values = Array.isArray(response) ? response : [response];
    const normalizedLocations = values
      .map((value) => normalizeLocation(value, relationship))
      .filter((location): location is EvidenceLocation => location !== undefined);
    const locations = deduplicateLocations(normalizedLocations);

    return {
      locations,
      query: {
        status: locations.length > 0 ? "returned" : "no-results",
        returnedLocationCount: locations.length,
        ignoredResultCount: values.length - normalizedLocations.length,
        message:
          locations.length === 0
            ? "The provider command completed without returning supported locations."
            : undefined,
      },
    };
  } catch (error) {
    return {
      locations: [],
      query: {
        status: "failed",
        returnedLocationCount: 0,
        ignoredResultCount: 0,
        message: `Language provider request failed: ${getErrorMessage(error)}`,
      },
    };
  }
}

function normalizeLocation(
  value: unknown,
  relationship: EvidenceRelationship,
): EvidenceLocation | undefined {
  if (value instanceof vscode.Location) {
    return createEvidenceLocation(value.uri, value.range, relationship);
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const targetUri = value.targetUri;
  const targetSelectionRange = value.targetSelectionRange;
  const targetRange =
    targetSelectionRange instanceof vscode.Range
      ? targetSelectionRange
      : value.targetRange;
  if (targetUri instanceof vscode.Uri && targetRange instanceof vscode.Range) {
    return createEvidenceLocation(targetUri, targetRange, relationship);
  }

  const uri = value.uri;
  const range = value.range;
  if (uri instanceof vscode.Uri && range instanceof vscode.Range) {
    return createEvidenceLocation(uri, range, relationship);
  }

  return undefined;
}

function createEvidenceLocation(
  uri: vscode.Uri,
  range: vscode.Range,
  relationship: EvidenceRelationship,
): EvidenceLocation {
  return {
    relationship,
    uri: uri.toString(),
    range: toSourceRange(range),
  };
}

function toSourceRange(range: vscode.Range): SourceRange {
  return {
    start: {
      line: range.start.line,
      character: range.start.character,
    },
    end: {
      line: range.end.line,
      character: range.end.character,
    },
  };
}

function deduplicateLocations(
  locations: readonly EvidenceLocation[],
): readonly EvidenceLocation[] {
  const seen = new Set<string>();

  return locations.filter((location) => {
    const key = [
      location.relationship,
      location.uri,
      location.range.start.line,
      location.range.start.character,
      location.range.end.line,
      location.range.end.character,
    ].join(":");

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function determineInvestigationStatus(
  definitionStatus: ProviderResultStatus,
  referenceStatus: ProviderResultStatus,
): InvestigationStatus {
  const statuses = [definitionStatus, referenceStatus];

  if (statuses.every((status) => status === "failed")) {
    return "failed";
  }

  if (statuses.every((status) => status === "unavailable")) {
    return "unavailable";
  }

  if (
    statuses.some(
      (status) => status === "failed" || status === "unavailable",
    )
  ) {
    return "partial";
  }

  return "completed";
}

function createLimitations(
  definitionQuery: ProviderQuery,
  referenceQuery: ProviderQuery,
): readonly string[] {
  const limitations = [
    "Locations are returned by active VS Code language providers and represent source evidence only.",
    "References do not prove function calls, runtime behavior, or complete change impact.",
    "The reference query requests declaration inclusion when supported by the active provider.",
  ];

  appendProviderLimitation(limitations, "Definition", definitionQuery);
  appendProviderLimitation(limitations, "Reference", referenceQuery);

  return limitations;
}

function appendProviderLimitation(
  limitations: string[],
  label: string,
  query: ProviderQuery,
): void {
  if (query.status === "no-results") {
    limitations.push(
      `${label} lookup did not return supported locations; this does not prove that no ${label.toLowerCase()} exists.`,
    );
  }

  if (query.status === "unavailable" || query.status === "failed") {
    limitations.push(
      `${label} lookup could not provide results: ${query.message ?? "unknown provider state"}`,
    );
  }

  if (query.ignoredResultCount > 0) {
    limitations.push(
      `${label} lookup returned ${query.ignoredResultCount} unsupported or malformed result${query.ignoredResultCount === 1 ? "" : "s"}.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
