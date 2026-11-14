import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext): void {
  const exploreCurrentSymbolCommand = vscode.commands.registerCommand(
    "nexus.exploreCurrentSymbol",
    () => {
      const editor = vscode.window.activeTextEditor;

      if (!editor) {
        void vscode.window.showInformationMessage(
          "Nexus is running. Open a text editor to explore the current symbol.",
        );
        return;
      }

      const documentPath =
        editor.document.uri.scheme === "file"
          ? editor.document.uri.fsPath
          : editor.document.uri.toString();
      const position = editor.selection.active;

      void vscode.window.showInformationMessage(
        `Nexus is running. Active document: ${documentPath}. Cursor: line ${
          position.line + 1
        }, column ${position.character + 1}.`,
      );
    },
  );

  context.subscriptions.push(exploreCurrentSymbolCommand);
}
