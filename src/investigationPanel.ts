import { randomBytes, randomUUID } from "crypto";
import * as vscode from "vscode";
import {
  type EvidenceLocation,
  type ProviderQuery,
  type SourceRange,
  type SymbolInvestigation,
} from "./investigationModel";

interface RenderableEvidence {
  readonly id: string;
  readonly location: EvidenceLocation;
}

interface NavigationMessage {
  readonly command: "navigate";
  readonly evidenceId: string;
}

export class InvestigationPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly evidenceById = new Map<string, EvidenceLocation>();

  show(investigation: SymbolInvestigation): void {
    const panel = this.getOrCreatePanel();
    panel.title = `Nexus: ${investigation.symbol.name}`;
    panel.webview.html = this.render(investigation);
    panel.reveal(vscode.ViewColumn.Beside);
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.evidenceById.clear();
  }

  private getOrCreatePanel(): vscode.WebviewPanel {
    if (this.panel) {
      return this.panel;
    }

    const panel = vscode.window.createWebviewPanel(
      "nexus.investigationResults",
      "Nexus: Investigation",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [],
        retainContextWhenHidden: false,
      },
    );

    panel.webview.onDidReceiveMessage(
      (message: unknown) => {
        void this.handleMessage(message);
      },
      undefined,
    );
    panel.onDidDispose(
      () => {
        this.panel = undefined;
        this.evidenceById.clear();
      },
      undefined,
    );
    this.panel = panel;
    return panel;
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isNavigationMessage(message)) {
      return;
    }

    const location = this.evidenceById.get(message.evidenceId);
    if (!location) {
      return;
    }

    try {
      const uri = vscode.Uri.parse(location.uri);
      const range = toVscodeRange(location.range);
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, {
        preview: false,
        selection: range,
      });
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Nexus could not open this evidence location: ${getErrorMessage(error)}`,
      );
    }
  }

  private render(investigation: SymbolInvestigation): string {
    this.evidenceById.clear();
    const definitions = this.createRenderableEvidence(investigation.definitions);
    const references = this.createRenderableEvidence(investigation.references);
    const nonce = randomBytes(16).toString("base64");
    const webview = this.panel?.webview;

    if (!webview) {
      return "";
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <title>Nexus Investigation</title>
  <style nonce="${nonce}">
    :root { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    body { margin: 0; padding: 16px; line-height: 1.4; }
    main { margin: 0 auto; max-width: 960px; }
    h1, h2, p { margin-top: 0; }
    h1 { font-size: 1.35em; margin-bottom: 2px; }
    h2 { font-size: 1.05em; margin-bottom: 6px; }
    .eyebrow, .meta, .empty, .query-message, .status-detail { color: var(--vscode-descriptionForeground); }
    .eyebrow { font-size: .85em; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin-bottom: 10px; padding: 12px; }
    .status { border-radius: 999px; display: inline-block; font-size: .85em; font-weight: 600; margin: 6px 0; padding: 2px 8px; }
    .status-completed { background: var(--vscode-testing-iconPassed); color: var(--vscode-editor-background); }
    .status-partial, .status-unavailable { background: var(--vscode-editorWarning-foreground); color: var(--vscode-editor-background); }
    .status-failed { background: var(--vscode-testing-iconFailed); color: var(--vscode-editor-background); }
    .evidence-list, .limitations { list-style: none; margin: 0; padding: 0; }
    .evidence-list li + li, .limitations li + li { margin-top: 6px; }
    .evidence { align-items: center; background: var(--vscode-button-secondaryBackground); border: 1px solid transparent; border-radius: 4px; color: var(--vscode-button-secondaryForeground); cursor: pointer; display: flex; font: inherit; gap: 8px; padding: 6px 8px; text-align: left; width: 100%; }
    .evidence:hover, .evidence:focus-visible { background: var(--vscode-button-secondaryHoverBackground); border-color: var(--vscode-focusBorder); outline: none; }
    .location { color: var(--vscode-textLink-foreground); flex: 1; overflow-wrap: anywhere; }
    .line { color: var(--vscode-descriptionForeground); white-space: nowrap; }
    .warning { border-left: 3px solid var(--vscode-editorWarning-foreground); padding-left: 10px; }
  </style>
</head>
<body>
  <main>
    <section class="card">
      <div class="eyebrow">Nexus investigation</div>
      <h1>${escapeHtml(investigation.symbol.name)}</h1>
      <p class="meta">${escapeHtml(formatUri(investigation.symbol.sourceUri))} · ${escapeHtml(formatRange(investigation.symbol.range))}</p>
      <div class="status status-${escapeHtml(investigation.status)}">${escapeHtml(formatStatus(investigation.status))}</div>
      <p class="status-detail">${escapeHtml(getStatusDetail(investigation))}</p>
    </section>
    ${renderEvidenceSection("Definitions", definitions, investigation.definitionQuery)}
    ${renderEvidenceSection("References", references, investigation.referenceQuery)}
    <section class="card">
      <h2>Limitations and evidence disclaimer</h2>
      ${renderLimitations(investigation.limitations)}
    </section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll("[data-evidence-id]").forEach((element) => {
      element.addEventListener("click", () => {
        const evidenceId = element.dataset.evidenceId;
        if (evidenceId) {
          vscode.postMessage({ command: "navigate", evidenceId });
        }
      });
    });
  </script>
</body>
</html>`;
  }

  private createRenderableEvidence(
    locations: readonly EvidenceLocation[],
  ): readonly RenderableEvidence[] {
    return locations.map((location) => {
      const id = randomUUID();
      this.evidenceById.set(id, location);

      return { id, location };
    });
  }
}

function renderEvidenceSection(
  title: string,
  evidence: readonly RenderableEvidence[],
  query: ProviderQuery,
): string {
  const count = evidence.length;
  const content =
    count === 0
      ? `<p class="empty">${escapeHtml(query.message ?? `No ${title.toLowerCase()} found.`)}</p>`
      : `<ul class="evidence-list">${evidence
          .map(
            ({ id, location }) => `<li>
  <button class="evidence" type="button" data-evidence-id="${escapeHtml(id)}">
    <span class="location">${escapeHtml(formatUri(location.uri))}</span>
    <span class="line">${escapeHtml(formatRange(location.range))}</span>
  </button>
</li>`,
          )
          .join("")}</ul>`;

  return `<section class="card">
  <h2>${escapeHtml(title)} <span class="meta">(${count} ${count === 1 ? "location" : "locations"})</span></h2>
  <p class="meta">Provider status: ${escapeHtml(query.status)}</p>
  ${query.message ? `<p class="query-message">${escapeHtml(query.message)}</p>` : ""}
  ${content}
  ${query.ignoredResultCount > 0 ? `<p class="query-message warning">Ignored ${query.ignoredResultCount} unsupported provider result${query.ignoredResultCount === 1 ? "" : "s"}.</p>` : ""}
</section>`;
}

function renderLimitations(limitations: readonly string[]): string {
  if (limitations.length === 0) {
    return `<p class="empty">No limitations were reported for this investigation.</p>`;
  }

  return `<ul class="limitations">${limitations
    .map((limitation) => `<li>${escapeHtml(limitation)}</li>`)
    .join("")}</ul>`;
}

function isNavigationMessage(message: unknown): message is NavigationMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }

  const candidate = message as Record<string, unknown>;
  return (
    candidate.command === "navigate" &&
    typeof candidate.evidenceId === "string" &&
    candidate.evidenceId.length > 0
  );
}

function toVscodeRange(range: SourceRange): vscode.Range {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  );
}

function formatUri(uriValue: string): string {
  try {
    const uri = vscode.Uri.parse(uriValue);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);

    if (workspaceFolder) {
      return vscode.workspace.asRelativePath(uri, false);
    }

    return uri.scheme === "file" ? uri.fsPath : uri.toString();
  } catch {
    return uriValue;
  }
}

function formatRange(range: SourceRange): string {
  const start = `${range.start.line + 1}:${range.start.character + 1}`;
  const end = `${range.end.line + 1}:${range.end.character + 1}`;

  return start === end ? start : `${start}-${end}`;
}

function formatStatus(status: SymbolInvestigation["status"]): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function getStatusDetail(investigation: SymbolInvestigation): string {
  if (investigation.status === "completed") {
    return investigation.definitions.length + investigation.references.length > 0
      ? "Provider requests completed and returned the evidence listed below."
      : "Provider requests completed, but no evidence locations were returned.";
  }

  return "The provider results below may be incomplete. Review query messages and limitations before drawing conclusions.";
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
