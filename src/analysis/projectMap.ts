/**
 * Project map: how files in the workspace import each other, and where
 * the current file sits among them.
 *
 * Import edges come from import statements read in each file and are
 * resolved to workspace files by path. An edge is only drawn when the
 * import resolves to exactly one file, so the map never guesses.
 */
import { buildFileContext } from "./fileContext";
import { profileFor } from "./languageProfiles";
import { shorten } from "./text";

export interface ProjectFile {
  /** Workspace-relative path with forward slashes, e.g. "app/utils.py". */
  readonly path: string;
  readonly uri: string;
  readonly languageId: string;
  readonly text: string;
}

export interface ImportEdge {
  readonly from: string;
  readonly to: string;
  readonly line: number;
  readonly excerpt: string;
  /** Names the importing file takes from the target, when listed. */
  readonly names: readonly string[];
}

export interface ProjectGraph {
  readonly files: readonly { readonly path: string; readonly uri: string }[];
  readonly edges: readonly ImportEdge[];
  readonly limited: boolean;
}

export type FileRole = "current" | "uses" | "used-by" | "reference" | "definition" | "other";

export interface MapFile {
  readonly path: string;
  readonly uri: string;
  readonly role: FileRole;
}

export interface ProjectMapView {
  readonly totalFiles: number;
  readonly limited: boolean;
  readonly currentPath: string;
  /** Project → folders → file → enclosing declarations → the selection. */
  readonly zoom: readonly { readonly kind: string; readonly label: string }[];
  readonly usedBy: readonly { readonly path: string; readonly uri: string; readonly line: number; readonly excerpt: string }[];
  readonly uses: readonly { readonly path: string; readonly uri: string; readonly line: number; readonly names: readonly string[] }[];
  readonly files: readonly MapFile[];
}

const MAX_FILE_CHARACTERS = 300_000;

/** Builds import edges between workspace files. */
export function buildProjectGraph(files: readonly ProjectFile[], limited: boolean): ProjectGraph {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const edges: ImportEdge[] = [];

  for (const file of files) {
    if (file.text.length > MAX_FILE_CHARACTERS) {
      continue;
    }
    let context;
    try {
      context = buildFileContext(file.text, profileFor(file.languageId));
    } catch {
      continue;
    }

    const modules = new Map<string, { line: number; excerpt: string; names: string[] }>();
    const note = (module: string, line: number, excerpt: string, name?: string): void => {
      const entry = modules.get(module) ?? { line, excerpt, names: [] };
      if (name && !entry.names.includes(name)) {
        entry.names.push(name);
      }
      modules.set(module, entry);
    };
    context.imports.forEach((binding) => {
      note(binding.module, binding.line, binding.statementText, binding.form === "member" ? binding.importedName.split(/[.:]/).pop() : undefined);
      if (binding.form === "member" && file.languageId === "python") {
        // `from pkg import mod` may import a module file.
        note(`${binding.module}.${binding.importedName}`, binding.line, binding.statementText);
      }
    });
    context.wildcardImports.forEach((entry) => note(entry.module, entry.line, entry.statementText));

    const seenTargets = new Set<string>();
    for (const [module, info] of modules) {
      const target = resolveModule(module, file, byPath);
      if (target && target !== file.path && !seenTargets.has(target)) {
        seenTargets.add(target);
        edges.push({ from: file.path, to: target, line: info.line, excerpt: shorten(info.excerpt, 140), names: info.names.slice(0, 6) });
      }
    }
  }

  return { files: files.map((file) => ({ path: file.path, uri: file.uri })), edges, limited };
}

/** Resolves an import string to exactly one workspace file path, or undefined. */
export function resolveModule(module: string, from: ProjectFile, byPath: ReadonlyMap<string, ProjectFile>): string | undefined {
  const directory = from.path.includes("/") ? from.path.slice(0, from.path.lastIndexOf("/")) : "";
  const candidates: string[] = [];

  if (from.languageId === "python") {
    const leadingDots = /^\.+/.exec(module)?.[0].length ?? 0;
    const rest = module.slice(leadingDots).replace(/\./g, "/");
    let base = directory;
    for (let level = 1; level < leadingDots; level += 1) {
      base = base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : "";
    }
    const join = (prefix: string): string => [prefix, rest].filter(Boolean).join("/");
    const roots = leadingDots > 0 ? [base] : ["", directory, "src"];
    for (const root of roots) {
      candidates.push(`${join(root)}.py`, `${join(root)}/__init__.py`);
    }
  } else if (["javascript", "javascriptreact", "typescript", "typescriptreact"].includes(from.languageId)) {
    if (!module.startsWith(".")) {
      return undefined; // A package from node_modules, not a project file.
    }
    const joined = normalizePath(`${directory}/${module}`);
    const stripped = joined.replace(/\.(js|jsx|mjs|cjs)$/, "");
    for (const extension of ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) {
      candidates.push(`${stripped}${extension}`, `${joined}${extension}`);
    }
    for (const extension of [".ts", ".tsx", ".js", ".jsx"]) {
      candidates.push(`${stripped}/index${extension}`);
    }
  } else if (["c", "cpp"].includes(from.languageId)) {
    candidates.push(normalizePath(`${directory}/${module}`), module);
  } else if (from.languageId === "rust") {
    const parts = module.replace(/^crate::/, "").split("::");
    for (let length = parts.length; length > 0; length -= 1) {
      const path = parts.slice(0, length).join("/");
      candidates.push(`src/${path}.rs`, `src/${path}/mod.rs`);
    }
  } else if (from.languageId === "go") {
    const last = module.split("/").filter(Boolean);
    if (last.length > 1) {
      const suffix = last.slice(-2).join("/");
      const matches = [...byPath.keys()].filter((path) => path.startsWith(`${suffix}/`) || path.includes(`/${suffix}/`));
      const dirs = new Set(matches.map((path) => path.slice(0, path.lastIndexOf("/"))));
      if (dirs.size === 1) {
        return matches[0];
      }
    }
    return undefined;
  }

  const found = [...new Set(candidates.map(normalizePath))].filter((candidate) => byPath.has(candidate));
  return found.length >= 1 ? found[0] : undefined;
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

export interface MapViewInput {
  readonly graph: ProjectGraph;
  readonly currentPath: string;
  readonly projectName: string;
  /** Enclosing declarations of the selection, outermost first, e.g. ["class Report", "function parse"]. */
  readonly enclosing: readonly string[];
  readonly selectionLabel: string;
  /** Paths the language server reported as definitions or references. */
  readonly definitionPaths: readonly string[];
  readonly referencePaths: readonly string[];
}

export function buildMapView(input: MapViewInput): ProjectMapView {
  const { graph, currentPath } = input;
  const usedBy = graph.edges
    .filter((edge) => edge.to === currentPath)
    .map((edge) => ({ path: edge.from, uri: uriOf(graph, edge.from), line: edge.line, excerpt: edge.excerpt }));
  const uses = graph.edges
    .filter((edge) => edge.from === currentPath)
    .map((edge) => ({ path: edge.to, uri: uriOf(graph, edge.to), line: edge.line, names: edge.names }));

  const roleOf = (path: string): FileRole => {
    if (path === currentPath) return "current";
    if (input.definitionPaths.includes(path)) return "definition";
    if (input.referencePaths.includes(path)) return "reference";
    if (usedBy.some((entry) => entry.path === path)) return "used-by";
    if (uses.some((entry) => entry.path === path)) return "uses";
    return "other";
  };

  const folders = currentPath.includes("/") ? currentPath.split("/").slice(0, -1) : [];
  const zoom = [
    { kind: "project", label: input.projectName },
    ...folders.map((folder) => ({ kind: "folder", label: folder })),
    { kind: "file", label: currentPath.split("/").pop() ?? currentPath },
    ...input.enclosing.map((label) => ({ kind: "declaration", label })),
    { kind: "selection", label: input.selectionLabel },
  ];

  return {
    totalFiles: graph.files.length,
    limited: graph.limited,
    currentPath,
    zoom,
    usedBy,
    uses,
    files: graph.files.map((file) => ({ path: file.path, uri: file.uri, role: roleOf(file.path) })),
  };
}

function uriOf(graph: ProjectGraph, path: string): string {
  return graph.files.find((file) => file.path === path)?.uri ?? path;
}

/** A short plain-text description of the map, given to the AI as verified context. */
export function describeMapForAi(view: ProjectMapView): string[] {
  const lines = [`Project has ${view.totalFiles} source files${view.limited ? " (list truncated)" : ""}.`];
  if (view.usedBy.length > 0) {
    lines.push(`Files that import ${view.currentPath}: ${view.usedBy.map((entry) => entry.path).join(", ")}.`);
  }
  if (view.uses.length > 0) {
    lines.push(`${view.currentPath} imports these project files: ${view.uses.map((entry) => entry.path + (entry.names.length ? ` (${entry.names.join(", ")})` : "")).join(", ")}.`);
  }
  return lines;
}
