import * as vscode from "vscode";
import {
  type EvidenceLocation,
  type InvestigatedSymbol,
  type ProviderQuery,
  type SourcePosition,
  type SourceRange,
  type SymbolInvestigation,
} from "./investigationModel";
import { investigateSymbol } from "./symbolInvestigator";

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("Nexus");
  const exploreCurrentSymbolCommand = vscode.commands.registerCommand(
    "nexus.exploreCurrentSymbol",
    async () => {
      const editor = vscode.window.activeTextEditor;

      if (!editor) {
        void vscode.window.showInformationMessage(
          "Nexus is running. Open a text editor to explore the current symbol.",
        );
        return;
      }

      const symbol = getSelectedSymbol(editor);
      if (!symbol) {
        void vscode.window.showWarningMessage(
          "Nexus could not identify a symbol from the current selection or cursor position.",
        );
        return;
      }

      try {
        const investigation = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Nexus: Investigating ${symbol.name}`,
            cancellable: false,
          },
          () => investigateSymbol(editor.document, symbol),
        );

        writeInvestigationReport(outputChannel, investigation);
        outputChannel.show(true);
        showInvestigationSummary(investigation);
      } catch (error) {
        const message = getErrorMessage(error);
        outputChannel.appendLine(
          `Unexpected investigation error for ${symbol.name}: ${message}`,
        );
        outputChannel.show(true);
        void vscode.window.showErrorMessage(
          `Nexus could not complete the investigation: ${message}`,
        );
      }
    },
  );

  context.subscriptions.push(outputChannel, exploreCurrentSymbolCommand);
}

function getSelectedSymbol(
  editor: vscode.TextEditor,
): InvestigatedSymbol | undefined {
  const selection = editor.selection;
  const sourceUri = editor.document.uri.toString();

  if (!selection.isEmpty) {
    const selectedText = editor.document.getText(selection);
    const trimmedText = selectedText.trim();

    if (!trimmedText) {
      return undefined;
    }

    const leadingWhitespace = selectedText.length - selectedText.trimStart().length;
    const providerPosition = editor.document.positionAt(
      editor.document.offsetAt(selection.start) + leadingWhitespace,
    );

    return {
      name: trimmedText,
      origin: "selection",
      sourceUri,
      range: toSourceRange(selection),
      providerPosition: toSourcePosition(providerPosition),
    };
  }

  const wordRange = editor.document.getWordRangeAtPosition(selection.active);
  if (!wordRange) {
    return undefined;
  }

  return {
    name: editor.document.getText(wordRange),
    origin: "word",
    sourceUri,
    range: toSourceRange(wordRange),
    providerPosition: toSourcePosition(selection.active),
  };
}

function writeInvestigationReport(
  outputChannel: vscode.OutputChannel,
  investigation: SymbolInvestigation,
): void {
  outputChannel.clear();
  outputChannel.appendLine("Nexus Symbol Investigation");
  outputChannel.appendLine("==========================");
  outputChannel.appendLine(`Timestamp: ${investigation.investigatedAt}`);
  outputChannel.appendLine(`Status: ${investigation.status}`);
  outputChannel.appendLine(
    `Symbol: ${investigation.symbol.name} (${investigation.symbol.origin})`,
  );
  outputChannel.appendLine(`Source: ${formatUri(investigation.symbol.sourceUri)}`);
  outputChannel.appendLine(
    `Investigated range: ${formatRange(investigation.symbol.range)}`,
  );
  outputChannel.appendLine("");

  appendEvidenceSection(
    outputChannel,
    "Definitions",
    investigation.definitions,
    investigation.definitionQuery,
  );
  appendEvidenceSection(
    outputChannel,
    "References",
    investigation.references,
    investigation.referenceQuery,
  );

  outputChannel.appendLine("Limitations:");
  for (const limitation of investigation.limitations) {
    outputChannel.appendLine(`- ${limitation}`);
  }
}

function appendEvidenceSection(
  outputChannel: vscode.OutputChannel,
  title: string,
  locations: readonly EvidenceLocation[],
  query: ProviderQuery,
): void {
  outputChannel.appendLine(
    `${title} (${query.status}; ${query.returnedLocationCount} location${query.returnedLocationCount === 1 ? "" : "s"}):`,
  );

  if (locations.length === 0) {
    outputChannel.appendLine(`- ${query.message ?? "No locations returned."}`);
  } else {
    for (const location of locations) {
      outputChannel.appendLine(
        `- ${formatUri(location.uri)}:${formatRange(location.range)}`,
      );
    }
  }

  if (query.ignoredResultCount > 0) {
    outputChannel.appendLine(
      `- Ignored ${query.ignoredResultCount} unsupported provider result${query.ignoredResultCount === 1 ? "" : "s"}.`,
    );
  }

  outputChannel.appendLine("");
}

function showInvestigationSummary(
  investigation: SymbolInvestigation,
): void {
  const summary = `Nexus investigated ${investigation.symbol.name}: ${investigation.definitions.length} definition${investigation.definitions.length === 1 ? "" : "s"}, ${investigation.references.length} reference${investigation.references.length === 1 ? "" : "s"}. See the Nexus Output channel.`;

  if (investigation.status === "completed") {
    void vscode.window.showInformationMessage(summary);
    return;
  }

  void vscode.window.showWarningMessage(
    `${summary} Some provider results were unavailable, incomplete, or failed.`,
  );
}

function toSourceRange(range: vscode.Range): SourceRange {
  return {
    start: toSourcePosition(range.start),
    end: toSourcePosition(range.end),
  };
}

function toSourcePosition(position: vscode.Position): SourcePosition {
  return {
    line: position.line,
    character: position.character,
  };
}

function formatUri(uriValue: string): string {
  const uri = vscode.Uri.parse(uriValue);
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);

  if (workspaceFolder) {
    return vscode.workspace.asRelativePath(uri, false);
  }

  return uri.scheme === "file" ? uri.fsPath : uri.toString();
}

function formatRange(range: SourceRange): string {
  const start = `${range.start.line + 1}:${range.start.character + 1}`;
  const end = `${range.end.line + 1}:${range.end.character + 1}`;

  return start === end ? start : `${start}-${end}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
