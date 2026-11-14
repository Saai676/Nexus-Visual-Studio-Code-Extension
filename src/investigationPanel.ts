import { randomBytes } from "crypto";
import * as vscode from "vscode";
import type { AiResult } from "./aiPrompt";
import type { Evidence, Explanation } from "./analysis/explanationModel";
import { renderAiResult, renderPanel } from "./panelHtml";

export interface PanelCallbacks {
  readonly onEnableAi: () => void;
  readonly onToggleFollow: () => void;
}

interface PanelMessage {
  readonly command: string;
  readonly evidenceId?: string;
  readonly cite?: string;
  readonly uri?: string;
}

/**
 * Owns the Nexus webview panel: renders explanations, validates every
 * message coming back from the webview, and opens evidence locations.
 * Only locations Nexus itself put in the explanation can be opened.
 */
export class InvestigationPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private evidenceById = new Map<string, Evidence>();
  /** Lines the current AI summary is allowed to link to, keyed "uri|line". */
  private aiCitations = new Set<string>();
  /** Files the project map may open. */
  private openableFiles = new Set<string>();
  private renderVersion = 0;

  constructor(private readonly callbacks: PanelCallbacks) {}

  get isVisible(): boolean {
    return this.panel?.visible ?? false;
  }

  get isOpen(): boolean {
    return this.panel !== undefined;
  }

  /** Shows an explanation and returns a version number used to match a later AI result. */
  show(explanation: Explanation, displayPath: string, aiEnabled: boolean, followCursor: boolean, preserveFocus: boolean): number {
    const panel = this.getOrCreatePanel(preserveFocus);
    this.renderVersion += 1;
    this.evidenceById = new Map(explanation.evidence.map((entry) => [entry.id, entry]));
    this.aiCitations.clear();
    this.openableFiles = new Set(explanation.projectMap?.files.map((file) => file.uri) ?? []);

    panel.title = explanation.hasContent ? `Nexus: ${shorten(explanation.heading, 28)}` : "Nexus";
    panel.webview.html = renderPanel(explanation, {
      nonce: randomBytes(16).toString("base64"),
      cspSource: panel.webview.cspSource,
      displayPath,
      aiEnabled,
      followCursor,
    });
    if (!panel.visible) {
      panel.reveal(vscode.ViewColumn.Beside, preserveFocus);
    }
    return this.renderVersion;
  }

  showAiResult(version: number, result: AiResult, enabled: boolean): void {
    if (!this.panel || version !== this.renderVersion) {
      return;
    }
    if (result.status === "ok") {
      for (const point of result.points) {
        for (const cite of point.citations) {
          this.aiCitations.add(`${cite.uri}|${cite.line}`);
        }
      }
    }
    void this.panel.webview.postMessage({ command: "aiResult", html: renderAiResult(result, enabled) });
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.evidenceById.clear();
  }

  private getOrCreatePanel(preserveFocus: boolean): vscode.WebviewPanel {
    if (this.panel) {
      return this.panel;
    }

    const panel = vscode.window.createWebviewPanel(
      "nexus.investigationResults",
      "Nexus",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
      { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true },
    );
    panel.iconPath = new vscode.ThemeIcon("lightbulb");
    panel.webview.onDidReceiveMessage((message: unknown) => void this.handleMessage(message));
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.evidenceById.clear();
    });
    this.panel = panel;
    return panel;
  }

  private async handleMessage(raw: unknown): Promise<void> {
    if (!isPanelMessage(raw)) {
      return;
    }

    switch (raw.command) {
      case "navigate": {
        const entry = raw.evidenceId ? this.evidenceById.get(raw.evidenceId) : undefined;
        if (entry) {
          await openLocation(entry.uri, entry.range.start.line, entry.range.start.character, entry.range.end.line, entry.range.end.character);
        }
        return;
      }
      case "navigateAi": {
        if (!raw.cite || !this.aiCitations.has(raw.cite)) {
          return;
        }
        const separator = raw.cite.lastIndexOf("|");
        const line = Number(raw.cite.slice(separator + 1));
        if (Number.isInteger(line)) {
          await openLocation(raw.cite.slice(0, separator), line, 0, line, 0);
        }
        return;
      }
      case "openFile":
        if (raw.uri && this.openableFiles.has(raw.uri)) {
          await openLocation(raw.uri, 0, 0, 0, 0);
        }
        return;
      case "enableAi":
        this.callbacks.onEnableAi();
        return;
      case "toggleFollow":
        this.callbacks.onToggleFollow();
        return;
      default:
        return;
    }
  }
}

async function openLocation(uriText: string, startLine: number, startCharacter: number, endLine: number, endCharacter: number): Promise<void> {
  try {
    const uri = vscode.Uri.parse(uriText);
    const range = new vscode.Range(startLine, startCharacter, endLine, endCharacter);
    const document = await vscode.workspace.openTextDocument(uri);
    const column = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === uriText)?.viewColumn ?? vscode.ViewColumn.One;
    const editor = await vscode.window.showTextDocument(document, { viewColumn: column, preview: false, selection: range });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  } catch (error) {
    void vscode.window.showErrorMessage(`Nexus could not open this location: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isPanelMessage(message: unknown): message is PanelMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const candidate = message as Record<string, unknown>;
  const allowed = ["navigate", "navigateAi", "openFile", "enableAi", "toggleFollow"];
  return (
    typeof candidate.command === "string" &&
    allowed.includes(candidate.command) &&
    (candidate.evidenceId === undefined || (typeof candidate.evidenceId === "string" && candidate.evidenceId.length <= 64)) &&
    (candidate.cite === undefined || (typeof candidate.cite === "string" && candidate.cite.length <= 2048)) &&
    (candidate.uri === undefined || (typeof candidate.uri === "string" && candidate.uri.length <= 2048))
  );
}

function shorten(value: string, max: number): string {
  const single = value.replace(/\s+/g, " ");
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}
