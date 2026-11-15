import * as vscode from "vscode";
import { AiSummarizer, type AiContextFile, type AiRequest } from "./aiSummary";
import { EXPLAIN_LEVELS, type ExplainLevel } from "./aiPrompt";
import { summarizeDeclarationAt } from "./analysis/crossFile";
import { buildMapView, buildProjectGraph, describeMapForAi, type ProjectFile, type ProjectGraph, type ProjectMapView } from "./analysis/projectMap";
import { buildProjectOverview, type ProjectOverview } from "./analysis/projectOverview";
import {
  buildExplanation,
  type DefinitionContext,
  type ImporterContext,
  type ProviderEvidence,
} from "./analysis/explanation";
import { richToPlain, type Explanation } from "./analysis/explanationModel";
import { enclosingDeclaration } from "./analysis/fileContext";
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
const MAX_IMPORTER_FILE_BYTES = 400_000;
const FOLLOW_DELAY_MS = 650;

const EXCLUDE_GLOB = "**/{node_modules,.git,dist,build,out,.venv,venv,env,__pycache__,target,bin,obj,.next,coverage,vendor}/**";


const SOURCE_GLOB = "**/*.{py,js,jsx,mjs,cjs,ts,tsx,java,c,h,cpp,hpp,cc,cs,go,rs}";
const MAX_PROJECT_FILES = 600;
const PROJECT_CACHE_MS = 45_000;

interface ProjectCacheEntry {
  readonly at: number;
  readonly graph: ProjectGraph;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Nexus");
  const ai = new AiSummarizer(context);
  const projectCache = new Map<string, ProjectCacheEntry>();
  let aiCancellation: vscode.CancellationTokenSource | undefined;
  let followTimer: NodeJS.Timeout | undefined;
  let running = 0;
  /** The AI request behind the current panel, so the reading level can be changed without re-running everything. */
  let lastAi: { version: number; request: AiRequest; kind?: "selection" | "project"; projectFiles?: readonly { path: string; uri: string }[] } | undefined;
  const currentLevel = (): ExplainLevel => {
    const value = config().get<string>("ai.explainLevel", "beginner");
    return EXPLAIN_LEVELS.some((entry) => entry.id === value) ? (value as ExplainLevel) : "beginner";
  };

  async function runProjectAi(version: number, request: AiRequest, projectFiles: readonly { path: string; uri: string }[]): Promise<void> {
    aiCancellation?.cancel();
    aiCancellation?.dispose();
    const source = new vscode.CancellationTokenSource();
    aiCancellation = source;
    const result = await ai.summarizeProject(request, projectFiles, source.token);
    if (!source.token.isCancellationRequested) {
      panel.showProjectAiResult(version, result, true);
    }
  }

  async function explainProject(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const folder = (editor && vscode.workspace.getWorkspaceFolder(editor.document.uri)) ?? vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showInformationMessage("Open a project folder first (File → Open Folder), then run “Nexus: Explain This Project”.");
      return;
    }
    const graph = await projectGraphFor(folder);

    // Where the user's selection is, if they have code open in this project.
    let currentPath: string | undefined;
    let selection: string | undefined;
    let enclosing: string[] = [];
    let analysis: SelectionAnalysis | undefined;
    if (editor && vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.toString() === folder.uri.toString()) {
      currentPath = vscode.workspace.asRelativePath(editor.document.uri, false);
      analysis = analyzeSelection({
        text: editor.document.getText(),
        languageId: editor.document.languageId,
        selectionStart: editor.document.offsetAt(editor.selection.start),
        selectionEnd: editor.document.offsetAt(editor.selection.end),
      });
      if (analysis.focusIndex !== -1) {
        selection = analysis.expressionText.length > 40 ? `${analysis.expressionText.slice(0, 39)}…` : analysis.expressionText;
        const focus = analysis.context.tokens[analysis.focusIndex];
        let index = enclosingDeclaration(analysis.context.declarations, focus.line);
        while (index !== -1) {
          const declaration = analysis.context.declarations[index];
          if (declaration.line !== focus.line) {
            enclosing.unshift(`${declaration.kind} ${declaration.name}`);
          }
          index = declaration.parent;
        }
      }
    }

    const overview = buildProjectOverview({ graph, projectName: folder.name, currentPath, selection, enclosing });
    const aiEnabled = ai.isEnabled();
    const version = panel.showProject(overview, aiEnabled, currentLevel());
    lastAi = undefined;
    if (aiEnabled) {
      const request = await buildProjectAiRequest(folder, overview, editor, analysis, selection);
      const projectFiles = graph.files.map((file) => ({ path: file.path, uri: file.uri }));
      lastAi = { version, request, kind: "project", projectFiles };
      await runProjectAi(version, request, projectFiles);
    }
  }

  async function runAiSummary(version: number, request: AiRequest): Promise<void> {
    aiCancellation?.cancel();
    aiCancellation?.dispose();
    const source = new vscode.CancellationTokenSource();
    aiCancellation = source;
    const result = await ai.summarize(request, source.token);
    if (!source.token.isCancellationRequested) {
      panel.showAiResult(version, result, true);
    }
  }

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
    onSetLevel: (level, version) => {
      void config().update("ai.explainLevel", level, vscode.ConfigurationTarget.Global);
      if (lastAi && lastAi.version === version) {
        const request = { ...lastAi.request, level };
        lastAi = { ...lastAi, request };
        if (lastAi.kind === "project") {
          void runProjectAi(version, request, lastAi.projectFiles ?? []);
        } else {
          void runAiSummary(version, request);
        }
      }
    },
    onExplainProject: () => {
      void vscode.commands.executeCommand("nexus.explainProject");
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
    const version = panel.show(explanation, displayPath(document.uri), aiEnabled, config().get<boolean>("followCursor", false), mode === "follow", currentLevel());
    writeOutput(output, explanation, document.uri);

    aiCancellation?.cancel();
    aiCancellation?.dispose();
    aiCancellation = undefined;
    lastAi = undefined;
    if (aiEnabled && explanation.hasContent && mode === "command") {
      const request = { ...(await buildAiRequest(document, analysis, explanation, provider)), level: currentLevel() };
      lastAi = { version, request };
      await runAiSummary(version, request);
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
    const projectMap = await projectMapFor(document, analysis, withExcerpts);
    const importers: ImporterContext[] | undefined =
      includeProject && isTopLevelDeclaration(analysis) && projectMap
        ? projectMap.usedBy.map((entry) => ({ uri: entry.uri, line: entry.line, excerpt: entry.excerpt }))
        : undefined;

    return {
      investigation: withExcerpts,
      documentation,
      definitionContexts,
      importers,
      projectMap,
    };
  }

  async function projectGraphFor(folder: vscode.WorkspaceFolder): Promise<ProjectGraph> {
    const key = folder.uri.toString();
    const cached = projectCache.get(key);
    if (cached && Date.now() - cached.at < PROJECT_CACHE_MS) {
      return cached.graph;
    }
    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, SOURCE_GLOB), EXCLUDE_GLOB, MAX_PROJECT_FILES + 1);
    const files: ProjectFile[] = [];
    await Promise.all(
      found.slice(0, MAX_PROJECT_FILES).map(async (uri) => {
        try {
          const open = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === uri.toString());
          let text = open?.getText();
          if (text === undefined) {
            const stat = await vscode.workspace.fs.stat(uri);
            text = stat.size > MAX_IMPORTER_FILE_BYTES ? "" : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
          }
          files.push({ path: vscode.workspace.asRelativePath(uri, false), uri: uri.toString(), languageId: open?.languageId ?? languageIdForPath(uri.path) ?? "plaintext", text });
        } catch {
          // Unreadable files are left out of the map.
        }
      }),
    );
    files.sort((a, b) => a.path.localeCompare(b.path));
    const graph = buildProjectGraph(files, found.length > MAX_PROJECT_FILES);
    projectCache.set(key, { at: Date.now(), graph });
    return graph;
  }

  async function projectMapFor(
    document: vscode.TextDocument,
    analysis: SelectionAnalysis,
    investigation: SymbolInvestigation | undefined,
  ): Promise<ProjectMapView | undefined> {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder || document.uri.scheme !== "file") {
      return undefined;
    }
    const graph = await projectGraphFor(folder);
    const currentPath = vscode.workspace.asRelativePath(document.uri, false);
    if (!graph.files.some((file) => file.path === currentPath)) {
      return undefined;
    }
    const focus = analysis.context.tokens[analysis.focusIndex];
    const enclosing: string[] = [];
    let index = enclosingDeclaration(analysis.context.declarations, focus.line);
    while (index !== -1) {
      const declaration = analysis.context.declarations[index];
      if (declaration.line !== focus.line) {
        enclosing.unshift(`${declaration.kind} ${declaration.name}`);
      }
      index = declaration.parent;
    }
    const toPath = (uri: string): string => vscode.workspace.asRelativePath(vscode.Uri.parse(uri), false);
    return buildMapView({
      graph,
      currentPath,
      projectName: folder.name,
      enclosing,
      selectionLabel: analysis.expressionText.length > 40 ? `${analysis.expressionText.slice(0, 39)}…` : analysis.expressionText,
      definitionPaths: (investigation?.definitions ?? []).map((location) => toPath(location.uri)),
      referencePaths: (investigation?.references ?? []).map((location) => toPath(location.uri)),
    });
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
    vscode.commands.registerCommand("nexus.explainProject", () =>
      vscode.window
        .withProgress({ location: vscode.ProgressLocation.Window, title: "Nexus: mapping the project…" }, () => explainProject())
        .then(undefined, (error: unknown) => {
          void vscode.window.showErrorMessage(`Nexus could not explain this project: ${error instanceof Error ? error.message : String(error)}`);
        }),
    ),
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
    vscode.workspace.onDidSaveTextDocument(() => projectCache.clear()),
    vscode.workspace.onDidCreateFiles(() => projectCache.clear()),
    vscode.workspace.onDidDeleteFiles(() => projectCache.clear()),
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

  const related = [
    ...(provider.projectMap?.usedBy ?? []).map((entry) => ({ uri: entry.uri, line: entry.line, role: "a file that imports this one" })),
    ...(provider.projectMap?.uses ?? []).map((entry) => ({ uri: entry.uri, line: 0, role: "a project file this one imports" })),
  ];
  for (const importer of related.slice(0, 5)) {
    try {
      const other = await vscode.workspace.openTextDocument(vscode.Uri.parse(importer.uri));
      const start = Math.max(0, importer.line - 3);
      const end = Math.min(other.lineCount, importer.line + 60);
      files.push({ label: displayPath(other.uri), uri: importer.uri, firstLine: start, lines: other.getText(new vscode.Range(start, 0, end, 0)).split(/\r?\n/), role: importer.role });
    } catch {
      // Skip files that cannot be opened.
    }
  }

  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (folder) {
    for (const name of ["README.md", "readme.md", "README.rst", "README.txt", "README"]) {
      try {
        const readme = vscode.Uri.joinPath(folder.uri, name);
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(readme));
        files.push({ label: name, uri: readme.toString(), firstLine: 0, lines: text.split(/\r?\n/).slice(0, 80), role: "the project's README" });
        break;
      } catch {
        // No README with this name.
      }
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
      .map((claim) => richToPlain(claim.text))
      .concat(provider.projectMap ? describeMapForAi(provider.projectMap) : []),
    projectFiles: provider.projectMap?.files.map((file) => file.path),
  };
}

/** Context for the whole-project AI explanation: README, starting files, core files, and the user's selection. */
async function buildProjectAiRequest(
  folder: vscode.WorkspaceFolder,
  overview: ProjectOverview,
  editor: vscode.TextEditor | undefined,
  analysis: SelectionAnalysis | undefined,
  selection: string | undefined,
): Promise<AiRequest> {
  const files: AiContextFile[] = [];
  const addFile = async (uri: string, label: string, role: string, firstLine: number, count: number): Promise<void> => {
    if (files.some((file) => file.uri === uri && file.firstLine === firstLine)) {
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
      const end = Math.min(document.lineCount, firstLine + count);
      files.push({ label, uri, firstLine, lines: document.getText(new vscode.Range(firstLine, 0, end, 0)).split(/\r?\n/), role });
    } catch {
      // Skip unreadable files.
    }
  };

  for (const name of ["README.md", "readme.md", "README.rst", "README.txt", "README"]) {
    try {
      const readme = vscode.Uri.joinPath(folder.uri, name);
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(readme));
      files.push({ label: name, uri: readme.toString(), firstLine: 0, lines: text.split(/\r?\n/).slice(0, 80), role: "the project's README" });
      break;
    } catch {
      // No README with this name.
    }
  }
  for (const entry of overview.entryPoints.slice(0, 2)) {
    await addFile(entry.uri, entry.path, "a file where the program starts", 0, 150);
  }
  const core = overview.layers.flat().filter((file) => file.role === "core").sort((a, b) => b.usedBy.length - a.usedBy.length);
  for (const file of core.slice(0, 3)) {
    await addFile(file.uri, file.path, "a core file many others import", 0, 70);
  }
  for (const file of (overview.layers[1] ?? []).slice(0, 3)) {
    await addFile(file.uri, file.path, "a file the starting file uses", 0, 50);
  }

  let selectedCode = "";
  let selectionLine = 0;
  const label = editor ? displayPath(editor.document.uri) : "";
  if (editor && analysis && analysis.focusIndex !== -1 && selection) {
    selectedCode = analysis.expressionText.slice(0, 600);
    selectionLine = analysis.context.lines.positionAt(analysis.context.tokens[analysis.focusIndex].start).line;
    const start = Math.max(0, selectionLine - 40);
    await addFile(editor.document.uri.toString(), label, "the file with the user's selection", start, 90);
  }

  const facts = [
    `The project "${overview.projectName}" has ${overview.totalFiles} source files.`,
    ...overview.entryPoints.map((entry) => `${entry.path} looks like a starting file: ${entry.entryReason ?? "no other file imports it"}.`),
    ...overview.layers.flat().filter((file) => file.uses.length > 0).slice(0, 12).map((file) => `${file.path} imports ${file.uses.join(", ")}.`),
  ];
  if (overview.here && overview.here.pathFromEntry.length > 1) {
    facts.push(`Import chain from a starting file to the user's file: ${overview.here.pathFromEntry.join(" -> ")}.`);
  }

  return {
    languageLabel: overview.languages.map((language) => language.label).join(", ") || "code",
    selectedCode: selectedCode || "(nothing selected: explain the whole project)",
    selectionLabel: label || "(none)",
    selectionLine,
    files,
    verifiedFacts: facts.slice(0, 20),
    projectFiles: [...overview.layers.flat(), ...overview.tests, ...overview.unconnected].map((file) => file.path),
    task: selectedCode
      ? "Explain this whole project in simple terms, then explain exactly where the user's selected code fits into it (fill in selectionFit)."
      : "Explain this whole project in simple terms. Nothing is selected, so set selectionFit to null.",
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
