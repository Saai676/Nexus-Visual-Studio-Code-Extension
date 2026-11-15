/**
 * Whole-project overview, built from the import graph (no AI).
 *
 * Answers: where does the program start, which files matter most, how
 * do the files depend on each other (as left-to-right layers), and in
 * what order should a newcomer read them. Optionally marks where the
 * user's current selection sits.
 */
import type { GraphFile, ProjectGraph } from "./projectMap";

export type FileRoleKind = "entry" | "core" | "helper" | "test" | "standalone";

export interface OverviewFile {
  readonly path: string;
  readonly uri: string;
  readonly role: FileRoleKind;
  readonly defines: readonly string[];
  readonly uses: readonly string[];
  readonly usedBy: readonly string[];
  readonly lineCount: number;
  readonly entryReason?: string;
  readonly here: boolean;
}

export interface TourStop {
  readonly path: string;
  readonly uri: string;
  readonly why: string;
}

export interface ProjectOverview {
  readonly projectName: string;
  readonly totalFiles: number;
  readonly limited: boolean;
  readonly languages: readonly { readonly label: string; readonly count: number }[];
  readonly entryPoints: readonly OverviewFile[];
  /** Left-to-right layers: entry points first, then what they use, and so on. */
  readonly layers: readonly (readonly OverviewFile[])[];
  readonly tests: readonly OverviewFile[];
  readonly unconnected: readonly OverviewFile[];
  readonly tour: readonly TourStop[];
  readonly here?: {
    readonly path: string;
    readonly selection: string;
    readonly zoom: readonly string[];
    /** Shortest chain of files from an entry point down to the current file. */
    readonly pathFromEntry: readonly string[];
  };
}

export interface OverviewInput {
  readonly graph: ProjectGraph;
  readonly projectName: string;
  readonly currentPath?: string;
  readonly selection?: string;
  readonly enclosing?: readonly string[];
}

const MAX_LAYERS = 6;
const MAX_PER_LAYER = 10;
const LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  python: "Python", javascript: "JavaScript", javascriptreact: "JavaScript", typescript: "TypeScript", typescriptreact: "TypeScript",
  java: "Java", c: "C", cpp: "C++", csharp: "C#", go: "Go", rust: "Rust",
};

export function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)(\/|$)|(^|\/)test_[^/]*$|_test\.[a-z]+$|\.(test|spec)\.[a-z]+$/i.test(path);
}

export function buildProjectOverview(input: OverviewInput): ProjectOverview {
  const { graph } = input;
  const uses = new Map<string, string[]>();
  const usedBy = new Map<string, string[]>();
  for (const edge of graph.edges) {
    (uses.get(edge.from) ?? uses.set(edge.from, []).get(edge.from)!).push(edge.to);
    (usedBy.get(edge.to) ?? usedBy.set(edge.to, []).get(edge.to)!).push(edge.from);
  }

  const files = graph.files.filter((file) => file.lineCount > 0 || (uses.get(file.path)?.length ?? 0) > 0 || (usedBy.get(file.path)?.length ?? 0) > 0);
  const nonTest = files.filter((file) => !isTestPath(file.path));

  // Entry points: what the code says starts the program; otherwise the roots of the import graph.
  let entries = nonTest.filter((file) => file.entryReason);
  if (entries.length === 0) {
    entries = nonTest
      .filter((file) => (usedBy.get(file.path)?.length ?? 0) === 0 && (uses.get(file.path)?.length ?? 0) > 0)
      .map((file) => ({ ...file, entryReason: "no other project file imports it, but it imports others" }));
  }
  entries = entries.slice(0, 4);

  // Layers by shortest distance from an entry point, following "uses" edges.
  const depth = new Map<string, number>();
  const parent = new Map<string, string>();
  const queue: string[] = [];
  for (const entry of entries) {
    depth.set(entry.path, 0);
    queue.push(entry.path);
  }
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of uses.get(current) ?? []) {
      if (!depth.has(next) && !isTestPath(next)) {
        depth.set(next, depth.get(current)! + 1);
        parent.set(next, current);
        queue.push(next);
      }
    }
  }

  const make = (file: GraphFile): OverviewFile => {
    const fileUses = uses.get(file.path) ?? [];
    const fileUsedBy = usedBy.get(file.path) ?? [];
    let role: FileRoleKind;
    if (isTestPath(file.path)) role = "test";
    else if (depth.get(file.path) === 0) role = "entry";
    else if (fileUsedBy.length >= 2) role = "core";
    else if (fileUsedBy.length === 1 || depth.has(file.path)) role = "helper";
    else role = "standalone";
    return {
      path: file.path,
      uri: file.uri,
      role,
      defines: file.defines,
      uses: fileUses,
      usedBy: fileUsedBy,
      lineCount: file.lineCount,
      entryReason: file.entryReason ?? (depth.get(file.path) === 0 ? entries.find((entry) => entry.path === file.path)?.entryReason : undefined),
      here: file.path === input.currentPath,
    };
  };

  const layers: OverviewFile[][] = [];
  for (const file of nonTest) {
    const level = depth.get(file.path);
    if (level === undefined) continue;
    const index = Math.min(level, MAX_LAYERS - 1);
    (layers[index] ??= []).push(make(file));
  }
  for (const layer of layers) {
    layer.sort((a, b) => Number(b.here) - Number(a.here) || b.usedBy.length - a.usedBy.length || a.path.localeCompare(b.path));
    layer.splice(MAX_PER_LAYER);
  }

  const tests = files.filter((file) => isTestPath(file.path)).map(make);
  const unconnected = nonTest.filter((file) => !depth.has(file.path)).map(make);

  // Reading tour: entry points, then breadth-first, preferring files many others depend on.
  const tour: TourStop[] = [];
  const seen = new Set<string>();
  const add = (path: string, why: string): void => {
    if (seen.has(path) || tour.length >= 10) return;
    seen.add(path);
    tour.push({ path, uri: graph.files.find((file) => file.path === path)?.uri ?? path, why });
  };
  for (const entry of entries) add(entry.path, `Start here: ${entry.entryReason}.`);
  for (const layer of layers.slice(1)) {
    for (const file of layer) {
      const users = file.usedBy.filter((user) => seen.has(user)).map(basename);
      add(file.path, file.usedBy.length >= 2 ? `Used by ${file.usedBy.length} files${users.length ? `, including ${users.slice(0, 2).join(" and ")}` : ""}.` : users.length ? `Used by ${users[0]}.` : "Part of the main flow.");
    }
  }
  if (tests.length > 0) add(tests[0].path, "A test: shows how the code above is meant to be used.");

  const counts = new Map<string, number>();
  for (const file of files) {
    const label = LANGUAGE_LABELS[file.languageId] ?? file.languageId;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  let here: ProjectOverview["here"];
  if (input.currentPath) {
    const chain: string[] = [];
    let cursor: string | undefined = input.currentPath;
    while (cursor && chain.length < 10) {
      chain.unshift(cursor);
      cursor = parent.get(cursor);
    }
    const folders = input.currentPath.includes("/") ? input.currentPath.split("/").slice(0, -1) : [];
    here = {
      path: input.currentPath,
      selection: input.selection ?? "",
      zoom: [input.projectName, ...folders, basename(input.currentPath), ...(input.enclosing ?? []), ...(input.selection ? [input.selection] : [])],
      pathFromEntry: depth.has(input.currentPath) ? chain : [],
    };
  }

  return {
    projectName: input.projectName,
    totalFiles: graph.files.length,
    limited: graph.limited,
    languages: [...counts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
    entryPoints: entries.map(make),
    layers,
    tests,
    unconnected,
    tour,
    here,
  };
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}
