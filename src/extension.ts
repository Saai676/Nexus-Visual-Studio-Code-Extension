import * as vscode from "vscode";
import { AiSummarizer, type AiContextFile, type AiRequest } from "./aiSummary";
import { summarizeDeclarationAt, findImportsOf } from "./analysis/crossFile";
import {
  buildExplanation,
  type DefinitionContext,
  type ImporterContext,
  type ProviderEvidence,
} from "./analysis/explanation";
import { richToPlain, type Explanation } from "./analysis/explanationModel";
import { analyzeSelection, type SelectionAnalysis } from "./analysis/selection";
import {
  type EvidenceLocation,
  type InvestigatedSymbol,
  type ProviderDocumentation,
  type SymbolInvestigation,
} from "./investigationModel";
import { InvestigationPanel } from "./investigationPanel";
import { investigateSymbol } from "./symbolInvestigator";

const MAX_DOCUMENTATION_CHARACTERS = 1_800;
const MAX_EXCERPT_FILES = 8;
const MAX_IMPORTER_SCAN = 400;
const MAX_IMPORTER_FILE_BYTES = 400_000;
const IMPORTER_CACHE_MS = 60_000;
const FOLLOW_DELAY_MS = 650;

const EXCLUDE_GLOB = "**/{node_modules,.git,dist,build,out,.venv,venv,env,__pycache__,target,bin,obj,.next,coverage,vendor}/**";

/** File extensions searched for imports of the current file, by language family. */
const IMPORT_SEARCH_GLOBS: Readonly<Record<string, string>> = {
  python: "**/*.py",
  javascript: "**/*.{js,jsx,mjs,cjs,ts,tsx}",
  javascriptreact: "**/*.{js,jsx,mjs,cjs,ts,tsx}",
  typescript: "**/*.{js,jsx,mjs,cjs,ts,tsx}",
  typescriptreact: "**/*.{js,jsx,mjs,cjs,ts,tsx}",
  c: "**/*.{c,h,cpp,hpp,cc}",
  cpp: "**/*.{c,h,cpp,hpp,cc}",
  rust: "**/*.rs",
  go: "**/*.go",
};

interface ImporterCacheEntry {
  readonly at: number;
  readonly importers: ImporterContext[];
  readonly scanned: number;
  readonly limited: boolean;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Nexus");
  const ai = new AiSummarizer(context);
  const importerCache = new Map<string, ImporterCacheEntry>();
  let aiCancellation: vscode.CancellationTokenSource | undefined;
  let followTimer: NodeJS.Timeout | undefined;
  let running = 0;

  const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration("nexus");

  const panel = new InvestigationPanel({
    onEnableAi: () => {
      void config().update("ai.enabled", true, vscode.ConfigurationTarget.Global).then(() => {
        void vscode.window.showInformationMessage("Nexus AI summaries are on. Run Nexus again to see one.", "Explain again").then((choice) => {
          if (choice) {
            void vscode.commands.executeCommand("nexus.explain");
          }
        });
      });
    },
    onToggleFollow: () => {
      void config().update("followCursor", !config().get<boolean>("followCursor", false), vscode.ConfigurationTarget.Global);
    },
  });

  async function explain(editor: vscode.TextEditor, mode: "command" | "follow"): Promise<void> {
    const runId = ++running;
    const document = editor.document;
    const text = document.getText();
    const analysis = analyzeSelection({
      text,
      languageId: document.languageId,
      selectionStart: document.offsetAt(editor.selection.start),
      selectionEnd: document.offsetAt(editor.selection.end),
    });

    const uri = document.uri.toString();
    const provider = await gatherProviderEvidence(document, analysis, mode === "command");
    if (runId !== running) {
      return; // A newer request started while this one waited on providers.
    }

    const explanation = buildExplanation(analysis, uri, provider);
    const aiEnabled = ai.isEnabled();
    const version = panel.show(explanation, displayPath(document.uri), aiEnabled, config().get<boolean>("followCursor", false), mode === "follow");
    writeOutput(output, explanation, document.uri);

    aiCancellation?.cancel();
    aiCancellation?.dispose();
    aiCancellation = undefined;
    if (aiEnabled && explanation.hasContent && mode === "command") {
      const source = new vscode.CancellationTokenSource();
      aiCancellation = source;
      const request = await buildAiRequest(document, analysis, explanation, provider);
      const result = await ai.summarize(request, source.token);
      if (!source.token.isCancellationRequested) {
        panel.showAiResult(version, result, aiEnabled);
      }
    } else if (aiEnabled && mode === "follow") {
      panel.showAiResult(version, { status: "disabled", message: "AI summaries run when you use the Explain command, not while following the cursor." }, aiEnabled);
    }
  }

  async function gatherProviderEvidence(
    document: vscode.TextDocument,
    analysis: SelectionAnalysis,
    includeProject: boolean,
  ): Promise<ProviderEvidence> {
    if (analysis.focusIndex === -1) {
      return { documentation: [] };
    }
    const { tokens } = analysis.context;
    const focus = tokens[analysis.focusIndex];
    const isName = analysis.focusKind === "name" || analysis.focusKind === "member";
    const position = document.positionAt(focus.start);

    const symbol: InvestigatedSymbol = {
      name: focus.text,
      origin: analysis.multiTokenSelection ? "selection" : "word",
      sourceUri: document.uri.toString(),
      range: { start: { line: position.line, character: position.character }, end: positionOf(document, focus.end) },
      providerPosition: { line: position.line, character: position.character },
    };

    const [investigation, documentation] = await Promise.all([
      isName ? investigateSymbol(document, symbol) : Promise.resolve(undefined),
      requestDocumentation(document, analysis),
    ]);

    const withExcerpts = investigation ? await addExcerpts(investigation, document) : undefined;
    const definitionContexts = withExcerpts && includeProject ? await definitionContextsFor(withExcerpts, document) : [];
    const importerResult = includeProject && isTopLevelDeclaration(analysis) ? await importersOf(document) : undefined;

    return {
      investigation: withExcerpts,
      documentation,
      definitionContexts,
      importers: importerResult?.importers,
      importerScan: importerResult ? { filesScanned: importerResult.scanned, limited: importerResult.limited } : undefined,
    };
  }

  async function importersOf(document: vscode.TextDocument): Promise<ImporterCacheEntry | undefined> {
    const glob = IMPORT_SEARCH_GLOBS[document.languageId];
    if (!glob || document.uri.scheme !== "file" || !vscode.workspace.getWorkspaceFolder(document.uri)) {
      return undefined;
    }
    const key = document.uri.toString();
    const cached = importerCache.get(key);
    if (cached && Date.now() - cached.at < IMPORTER_CACHE_MS) {
      return cached;
    }

    const base = document.uri.path.slice(document.uri.path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
    const names = base === "index" || base === "__init__" ? [document.uri.path.split("/").slice(-2, -1)[0] ?? base] : [base];
    const files = await vscode.workspace.findFiles(glob, EXCLUDE_GLOB, MAX_IMPORTER_SCAN + 1);
    const importers: ImporterContext[] = [];

    for (const file of files.slice(0, MAX_IMPORTER_SCAN)) {
      if (file.toString() === key || importers.length >= 25) {
        continue;
      }
      try {
        const stat = await vscode.workspace.fs.stat(file);
        if (stat.size > MAX_IMPORTER_FILE_BYTES) {
          continue;
        }
        const open = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === file.toString());
        const text = open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
        const languageId = open?.languageId ?? languageIdForPath(file.path) ?? document.languageId;
        for (const found of findImportsOf(text, languageId, names)) {
          importers.push({ uri: file.toString(), line: found.line, excerpt: found.excerpt });
          break;
        }
      } catch {
        // Unreadable file: skip it. The scan limit message covers incompleteness.
      }
    }

    const entry: ImporterCacheEntry = { at: Date.now(), importers, scanned: Math.min(files.length, MAX_IMPORTER_SCAN), limited: files.length > MAX_IMPORTER_SCAN };
    importerCache.set(key, entry);
    return entry;
  }

  const explainCommand = async (): Promise<void> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage("Open a file and click on some code, then run “Nexus: Explain This Code”.");
      return;
    }
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Nexus: reading the code…" },
        () => explain(editor, "command"),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`Unexpected error: ${message}`);
      void vscode.window.showErrorMessage(`Nexus could not explain this code: ${message}`);
    }
  };

  context.subscriptions.push(
    output,
    panel,
    vscode.commands.registerCommand("nexus.explain", explainCommand),
    vscode.commands.registerCommand("nexus.exploreCurrentSymbol", explainCommand),
    vscode.commands.registerCommand("nexus.toggleFollowCursor", () =>
      config().update("followCursor", !config().get<boolean>("followCursor", false), vscode.ConfigurationTarget.Global),
    ),
    vscode.commands.registerCommand("nexus.setGeminiApiKey", async () => {
      const key = await vscode.window.showInputBox({
        title: "Gemini API key for Nexus AI summaries",
        prompt: "Stored in VS Code's secure storage, never in a file. Leave empty to remove it.",
        password: true,
        ignoreFocusOut: true,
      });
      if (key === undefined) {
        return;
      }
      if (key.trim()) {
        await context.secrets.store("nexus.geminiApiKey", key.trim());
        void vscode.window.showInformationMessage("Gemini key saved. Set “Nexus › AI: Provider” to gemini to use it.");
      } else {
        await context.secrets.delete("nexus.geminiApiKey");
        void vscode.window.showInformationMessage("Gemini key removed.");
      }
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (!config().get<boolean>("followCursor", false) || !panel.isOpen) {
        return;
      }
      if (event.kind === vscode.TextEditorSelectionChangeKind.Command || !["file", "untitled"].includes(event.textEditor.document.uri.scheme)) {
        return;
      }
      clearTimeout(followTimer);
      followTimer = setTimeout(() => {
        if (vscode.window.activeTextEditor === event.textEditor) {
          void explain(event.textEditor, "follow").catch((error: unknown) => output.appendLine(`Follow error: ${String(error)}`));
        }
      }, FOLLOW_DELAY_MS);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("nexus.followCursor") && panel.isOpen) {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          void explain(editor, "follow");
        }
      }
    }),
    vscode.workspace.onDidSaveTextDocument(() => importerCache.clear()),
    { dispose: () => clearTimeout(followTimer) },
  );
}

export function deactivate(): void {
  // Nothing to clean up beyond the disposables registered in activate().
}

// ---------------------------------------------------------------------------

function positionOf(document: vscode.TextDocument, offset: number): { line: number; character: number } {
  const position = document.positionAt(offset);
  return { line: position.line, character: position.character };
}

function isTopLevelDeclaration(analysis: SelectionAnalysis): boolean {
  if (analysis.focusKind !== "name") {
    return false;
  }
  const focus = analysis.context.tokens[analysis.focusIndex];
  return analysis.context.declarations.some((declaration) => declaration.name === focus.text && declaration.parent === -1);
}

async function requestDocumentation(document: vscode.TextDocument, analysis: SelectionAnalysis): Promise<ProviderDocumentation[]> {
  const results: ProviderDocumentation[] = [];
  const { tokens } = analysis.context;

  for (const index of analysis.documentationTargets.slice(0, 2)) {
    const token = tokens[index];
    if (!token || (token.kind !== "identifier" && token.kind !== "keyword")) {
      continue;
    }
    const position = document.positionAt(token.start);
    try {
      const hovers = await vscode.commands.executeCommand<vscode.Hover[] | undefined>("vscode.executeHoverProvider", document.uri, position);
      const text = (hovers ?? [])
        .flatMap((hover) => hover.contents)
        .map((content) => (typeof content === "string" ? content : "value" in content ? content.value : ""))
        .join("\n\n")
        .replace(/```[a-z]*\n?/gi, "")
        .replace(/<[^>]+>/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (text && !results.some((existing) => existing.text === text)) {
        results.push({
          subject: token.text,
          position: { line: position.line, character: position.character },
          text: text.slice(0, MAX_DOCUMENTATION_CHARACTERS),
          truncated: text.length > MAX_DOCUMENTATION_CHARACTERS,
        });
      }
    } catch {
      // No hover provider: documentation is optional evidence.
    }
  }

  return results;
}

/** Reads the source line for each provider location so the panel can show real code. */
async function addExcerpts(investigation: SymbolInvestigation, active: vscode.TextDocument): Promise<SymbolInvestigation> {
  const cache = new Map<string, vscode.TextDocument | undefined>([[active.uri.toString(), active]]);
  const all = [...investigation.definitions, ...investigation.references];
  for (const location of all) {
    if (cache.size >= MAX_EXCERPT_FILES + 1 || cache.has(location.uri)) {
      continue;
    }
    try {
      cache.set(location.uri, await vscode.workspace.openTextDocument(vscode.Uri.parse(location.uri)));
    } catch {
      cache.set(location.uri, undefined);
    }
  }

  const withExcerpt = (location: EvidenceLocation): EvidenceLocation => {
    const document = cache.get(location.uri);
    if (!document || location.range.start.line >= document.lineCount) {
      return location;
    }
    return { ...location, excerpt: document.lineAt(location.range.start.line).text.trim().slice(0, 200) };
  };

  return { ...investigation, definitions: investigation.definitions.map(withExcerpt), references: investigation.references.map(withExcerpt) };
}

async function definitionContextsFor(investigation: SymbolInvestigation, active: vscode.TextDocument): Promise<DefinitionContext[]> {
  const contexts: DefinitionContext[] = [];
  for (const definition of investigation.definitions.slice(0, 2)) {
    if (definition.uri === active.uri.toString()) {
      continue;
    }
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(definition.uri));
      const summary = summarizeDeclarationAt(document.getText(), document.languageId, definition.range.start.line);
      if (summary) {
        contexts.push({ uri: definition.uri, range: definition.range, summary });
      }
    } catch {
      // Library files or virtual documents may not open; skip them.
    }
  }
  return contexts;
}

async function buildAiRequest(
  document: vscode.TextDocument,
  analysis: SelectionAnalysis,
  explanation: Explanation,
  provider: ProviderEvidence,
): Promise<AiRequest> {
  const files: AiContextFile[] = [];
  const focusLine = explanation.range.start.line;
  const label = displayPath(document.uri);
  const lines = document.getText().split(/\r?\n/);

  // The open file: the top (imports) plus a window around the selection.
  const headEnd = Math.min(lines.length, 40);
  const windowStart = Math.max(0, focusLine - 90);
  const windowEnd = Math.min(lines.length, focusLine + 90);
  if (windowStart <= headEnd) {
    files.push({ label, uri: document.uri.toString(), firstLine: 0, lines: lines.slice(0, Math.max(headEnd, windowEnd)), role: "the open file" });
  } else {
    files.push({ label, uri: document.uri.toString(), firstLine: 0, lines: lines.slice(0, headEnd), role: "the open file, top" });
    files.push({ label: `${label} `, uri: document.uri.toString(), firstLine: windowStart, lines: lines.slice(windowStart, windowEnd), role: "the open file, around the selection" });
  }

  for (const definition of provider.definitionContexts ?? []) {
    try {
      const other = await vscode.workspace.openTextDocument(vscode.Uri.parse(definition.uri));
      const start = Math.max(0, definition.range.start.line - 6);
      const end = Math.min(other.lineCount, definition.range.start.line + 60);
      files.push({ label: displayPath(other.uri), uri: definition.uri, firstLine: start, lines: other.getText(new vscode.Range(start, 0, end, 0)).split(/\r?\n/), role: "where it is defined" });
    } catch {
      // Skip files that cannot be opened.
    }
  }

  for (const importer of (provider.importers ?? []).slice(0, 3)) {
    try {
      const other = await vscode.workspace.openTextDocument(vscode.Uri.parse(importer.uri));
      const start = Math.max(0, importer.line - 3);
      const end = Math.min(other.lineCount, importer.line + 30);
      files.push({ label: displayPath(other.uri), uri: importer.uri, firstLine: start, lines: other.getText(new vscode.Range(start, 0, end, 0)).split(/\r?\n/), role: "a file that imports this one" });
    } catch {
      // Skip files that cannot be opened.
    }
  }

  return {
    languageLabel: explanation.languageLabel,
    selectedCode: analysis.expressionText.slice(0, 600),
    selectionLabel: label,
    selectionLine: focusLine,
    files,
    verifiedFacts: [...explanation.meaning, ...explanation.fits]
      .filter((claim) => claim.basis === "source" || claim.basis === "provider")
      .slice(0, 8)
      .map((claim) => richToPlain(claim.text)),
  };
}

function languageIdForPath(path: string): string | undefined {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Readonly<Record<string, string>> = {
    py: "python", js: "javascript", jsx: "javascriptreact", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescriptreact", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp", rs: "rust", go: "go",
  };
  return map[extension];
}

function displayPath(uri: vscode.Uri): string {
  return vscode.workspace.getWorkspaceFolder(uri) ? vscode.workspace.asRelativePath(uri, false) : uri.scheme === "file" ? uri.fsPath : uri.toString();
}

function writeOutput(output: vscode.OutputChannel, explanation: Explanation, uri: vscode.Uri): void {
  output.clear();
  output.appendLine(`Nexus · ${new Date().toISOString()}`);
  output.appendLine(`${displayPath(uri)}:${explanation.range.start.line + 1}  ${explanation.heading}  [${explanation.kindLabel}, ${explanation.languageLabel}]`);
  for (const claim of [...explanation.meaning, ...explanation.fits, ...explanation.project]) {
    output.appendLine(`  [${claim.basis}] ${richToPlain(claim.text)}`);
  }
  for (const unknown of explanation.unknowns) {
    output.appendLine(`  [unknown] ${richToPlain(unknown)}`);
  }
}
