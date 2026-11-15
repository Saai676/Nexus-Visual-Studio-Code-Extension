/**
 * Pure parts of the AI summary: the prompt, the data types, and the
 * validation of the answer. No VS Code imports, so this is unit-tested.
 */

export interface AiContextFile {
  /** Label shown to the model and the user, e.g. "main.py". */
  readonly label: string;
  readonly uri: string;
  /** The zero-based line number of the first line in `lines`. */
  readonly firstLine: number;
  readonly lines: readonly string[];
  /** Why this file is included, e.g. "open file", "definition". */
  readonly role: string;
}

export interface AiRequest {
  readonly languageLabel: string;
  readonly selectedCode: string;
  readonly selectionLabel: string;
  readonly selectionLine: number;
  readonly files: readonly AiContextFile[];
  /** The deterministic facts Nexus already established, as plain sentences. */
  readonly verifiedFacts: readonly string[];
  /** Workspace-relative paths of the project's source files (names only, no contents). */
  readonly projectFiles?: readonly string[];
  /** How simply to explain. Defaults to "beginner". */
  readonly level?: ExplainLevel;
  /** Replaces the final instruction (used for the whole-project explanation). */
  readonly task?: string;
}

export type ExplainLevel = "five" | "middle" | "beginner" | "developer";

export const EXPLAIN_LEVELS: readonly { readonly id: ExplainLevel; readonly label: string; readonly icon: string }[] = [
  { id: "five", label: "5-year-old", icon: "🧸" },
  { id: "middle", label: "Middle schooler", icon: "🎒" },
  { id: "beginner", label: "Beginner coder", icon: "🌱" },
  { id: "developer", label: "Developer", icon: "💻" },
];

/** Style instructions for each reading level. The evidence rules never change. */
const LEVEL_STYLE: Readonly<Record<ExplainLevel, string>> = {
  five: `READING LEVEL: explain it like you are talking to a 5-year-old.
- Use very short sentences and everyday words. No jargon at all: say "a list of things" not "an array", "a set of steps the computer follows" not "a function".
- Use one simple comparison from everyday life (toys, cooking, a school, a post office) to show what the code is like.
- The summary should be 3-4 tiny sentences. Flow steps should be one short sentence each.
- Still cite the file and line for every step, and never make anything up.`,
  middle: `READING LEVEL: explain it to a middle-school student who is curious but has never coded.
- Use plain words and short sentences. If you must use a coding word, explain it right away in brackets, e.g. "a variable (a labelled box that holds a value)".
- A friendly comparison to something from everyday life is welcome when it helps.
- Keep the summary to 4-5 sentences and each flow step to one sentence.`,
  beginner: `READING LEVEL: explain it to someone who is learning to program.
- Use correct technical terms, but explain each one in plain words the first time.`,
  developer: `READING LEVEL: explain it to an experienced developer who is new to this codebase.
- Be concise and precise; use normal technical vocabulary without defining basics.
- Focus on responsibilities, data flow, dependencies and side effects in this project.`,
};

export function levelStyle(level: ExplainLevel | undefined): string {
  return LEVEL_STYLE[level ?? "beginner"] ?? LEVEL_STYLE.beginner;
}

export interface AiCitation {
  readonly uri: string;
  readonly label: string;
  readonly line: number;
  readonly excerpt: string;
}

export interface AiPoint {
  readonly text: string;
  readonly citations: readonly AiCitation[];
}

export type AiResult =
  | {
      readonly status: "ok";
      readonly model: string;
      readonly summary: string;
      readonly role?: string;
      /** Step-by-step: how the selection fits into the flow of the project. */
      readonly flow: readonly AiPoint[];
      readonly inputs?: string;
      readonly outputs?: string;
      readonly dependsOnIt?: string;
      readonly points: readonly AiPoint[];
      readonly droppedCitations: number;
      readonly filesSent: readonly string[];
    }
  | { readonly status: "disabled" | "declined" | "unavailable" | "failed"; readonly message: string };

const MAX_LINES_PER_FILE = 260;
const MAX_TOTAL_CHARACTERS = 70_000;

export const SYSTEM_PROMPT = `You explain code to a beginner programmer inside the Nexus VS Code extension.

Rules you must follow:
1. Use ONLY the numbered source files given below. Do not use outside knowledge about this specific project, do not guess at code you were not shown, and do not mention websites or documentation.
2. You may use general programming knowledge to explain syntax and well-known language features.
3. When the given files do not show something, say so plainly (for example "The files shown do not say what this returns.").
4. Write short, plain sentences. Explain any technical term the first time you use it.
5. Every point about this project must cite the file label and line number it relies on, exactly as numbered below.

6. Be thorough but simple: a beginner should finish reading and understand exactly where this piece sits in the whole program and why it is there.

Reply with JSON only, no markdown fences, in this shape:
{"summary": "4-6 short sentences: what the selected code is, what it does here, and how it fits into the rest of this project",
 "role": "1-2 sentences: the job this piece does for the whole program, or null if the files do not show it",
 "flow": [{"text": "one step in the bigger picture, in order, e.g. 'main.py starts the app and calls load_data()'", "cite": [{"file": "main.py", "line": 12}]}],
 "inputs": "what this piece receives or depends on (values, other files, libraries), or null",
 "outputs": "what this piece produces or changes for the rest of the program, or null",
 "dependsOnIt": "which other parts of the project rely on this piece, and what would be affected if it changed, or null",
 "points": [{"text": "one extra useful detail", "cite": [{"file": "main.py", "line": 12}]}]}
"flow" should have 3-7 steps that walk from the wider program down to the selection and onwards, so it can be drawn as a flowchart. Put the step about the selection itself in the flow too. Give at most 4 points.`;

interface SentLine {
  readonly uri: string;
  readonly label: string;
  readonly text: string;
}

/** Builds the prompt and remembers exactly which lines were sent, so citations can be checked. */
export function buildPrompt(request: AiRequest): {
  prompt: string;
  sentLines: Map<string, SentLine>;
  filesSent: string[];
} {
  const sentLines = new Map<string, SentLine>();
  const filesSent: string[] = [];
  const sections: string[] = [];
  let budget = MAX_TOTAL_CHARACTERS;

  for (const file of request.files) {
    if (budget <= 0) {
      break;
    }
    const numbered: string[] = [];
    for (let index = 0; index < Math.min(file.lines.length, MAX_LINES_PER_FILE); index += 1) {
      const lineNumber = file.firstLine + index + 1;
      const text = file.lines[index].length > 300 ? `${file.lines[index].slice(0, 300)}…` : file.lines[index];
      const entry = `${String(lineNumber).padStart(4)} | ${text}`;
      if (budget - entry.length < 0) {
        break;
      }
      budget -= entry.length + 1;
      numbered.push(entry);
      sentLines.set(`${file.label}:${lineNumber}`, { uri: file.uri, label: file.label, text: file.lines[index] });
    }
    if (numbered.length > 0) {
      filesSent.push(file.label);
      sections.push(`=== FILE ${file.label} (${file.role}) ===\n${numbered.join("\n")}`);
    }
  }

  const tree = request.projectFiles && request.projectFiles.length > 0
    ? `\nAll source files in the project (names only):\n${request.projectFiles.slice(0, 200).map((path) => `- ${path}`).join("\n")}${request.projectFiles.length > 200 ? "\n- …" : ""}\n`
    : "";
  const facts = request.verifiedFacts.length > 0 ? request.verifiedFacts.map((fact) => `- ${fact}`).join("\n") : "- (none)";
  const prompt = `Language: ${request.languageLabel}
The user selected this code in ${request.selectionLabel}, line ${request.selectionLine + 1}:
${request.selectedCode}

Facts Nexus already verified from the source (do not contradict them):
${facts}
${tree}
${sections.join("\n\n")}

${levelStyle(request.level)}

${request.task ?? "Explain what the selected code does in the context of these files."}`;

  return { prompt, sentLines, filesSent };
}

/** Parses and validates the model's JSON. Citations to lines that were not sent are dropped. */
export function parseAnswer(
  text: string,
  model: string,
  sentLines: ReadonlyMap<string, SentLine>,
  filesSent: readonly string[],
): AiResult {
  const json = extractJson(text);
  if (!json || typeof json !== "object") {
    return { status: "failed", message: "The AI answer was not in the expected format, so Nexus did not show it." };
  }
  const record = json as Record<string, unknown>;
  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  if (!summary) {
    return { status: "failed", message: "The AI answer had no summary, so Nexus did not show it." };
  }

  let dropped = 0;
  const readPoints = (value: unknown, max: number): AiPoint[] => {
  const points: AiPoint[] = [];
  const rawPoints = Array.isArray(value) ? value.slice(0, max) : [];

  for (const raw of rawPoints) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const point = raw as Record<string, unknown>;
    const pointText = typeof point.text === "string" ? point.text.trim() : "";
    if (!pointText) {
      continue;
    }
    const citations: AiCitation[] = [];
    const rawCites = Array.isArray(point.cite) ? point.cite : [];
    for (const cite of rawCites.slice(0, 4)) {
      const entry = cite as Record<string, unknown>;
      const file = typeof entry?.file === "string" ? entry.file : "";
      const line = typeof entry?.line === "number" ? Math.trunc(entry.line) : Number.NaN;
      const sent = sentLines.get(`${file}:${line}`);
      if (sent) {
        citations.push({ uri: sent.uri, label: sent.label, line: line - 1, excerpt: sent.text.trim().slice(0, 140) });
      } else {
        dropped += 1;
      }
    }
    points.push({ text: pointText.slice(0, 400), citations });
  }
  return points;
  };
  const points = readPoints(record.points, 4);
  const flow = readPoints(record.flow, 7);
  const optionalText = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() && value.trim().toLowerCase() !== "null" ? value.trim().slice(0, 500) : undefined;

  const role = typeof record.role === "string" && record.role.trim() ? record.role.trim().slice(0, 500) : undefined;
  return {
    status: "ok",
    model,
    summary: summary.slice(0, 1200),
    role,
    flow,
    inputs: optionalText(record.inputs),
    outputs: optionalText(record.outputs),
    dependsOnIt: optionalText(record.dependsOnIt),
    points,
    droppedCitations: dropped,
    filesSent: [...filesSent],
  };
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}


// ---------------------------------------------------------------------------
// Whole-project explanation
// ---------------------------------------------------------------------------

export const PROJECT_SYSTEM_PROMPT = `You explain a whole software project to someone who has never seen it, inside the Nexus VS Code extension.

Rules you must follow:
1. Use ONLY the numbered files, the file list and the facts given below. Never invent files, features or behaviour. Do not mention websites.
2. You may use general programming knowledge to explain well-known libraries and language features, and say when you do.
3. When the files shown do not tell you something, say so plainly.
4. Cite the file label and line number for every claim about this project, exactly as numbered.
5. Be thorough but simple, following the READING LEVEL given at the end.

Reply with JSON only, no markdown fences, in this shape:
{"summary": "3-6 sentences: what this project is, what it does for its user, and how it does it at a high level",
 "purpose": "one sentence: the problem this project solves",
 "howItWorks": [{"text": "one step of what happens when the program runs, in order", "cite": [{"file": "main.py", "line": 3}]}],
 "parts": [{"file": "exact/path/from/the/file/list.py", "role": "one short sentence: the job of this file"}],
 "selectionFit": {"text": "2-4 sentences: where the user's selected code sits in this whole project and why it matters", "steps": [{"text": "step from the program's start down to the selection", "cite": [{"file": "main.py", "line": 3}]}]},
 "startHere": "one sentence of advice: which file to read first and why"}
"howItWorks" should have 3-7 steps. "parts" should cover the most important files (at most 8), using paths exactly as in the file list. If no code was selected, set "selectionFit" to null.`;

export interface ProjectPart {
  readonly path: string;
  readonly uri?: string;
  readonly role: string;
}

export type ProjectAiResult =
  | {
      readonly status: "ok";
      readonly model: string;
      readonly summary: string;
      readonly purpose?: string;
      readonly howItWorks: readonly AiPoint[];
      readonly parts: readonly ProjectPart[];
      readonly selectionFit?: { readonly text: string; readonly steps: readonly AiPoint[] };
      readonly startHere?: string;
      readonly droppedCitations: number;
      readonly filesSent: readonly string[];
    }
  | { readonly status: "disabled" | "declined" | "unavailable" | "failed"; readonly message: string };

/** Validates the whole-project answer: citations must match lines sent, parts must be real project files. */
export function parseProjectAnswer(
  text: string,
  model: string,
  sentLines: ReadonlyMap<string, SentLine>,
  filesSent: readonly string[],
  projectFiles: readonly { readonly path: string; readonly uri: string }[],
): ProjectAiResult {
  const json = extractJson(text);
  if (!json || typeof json !== "object") {
    return { status: "failed", message: "The AI answer was not in the expected format, so Nexus did not show it." };
  }
  const record = json as Record<string, unknown>;
  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  if (!summary) {
    return { status: "failed", message: "The AI answer had no summary, so Nexus did not show it." };
  }

  let dropped = 0;
  const points = (value: unknown, max: number): AiPoint[] =>
    (Array.isArray(value) ? value.slice(0, max) : [])
      .map((raw) => {
        const point = (raw ?? {}) as Record<string, unknown>;
        const pointText = typeof point.text === "string" ? point.text.trim().slice(0, 400) : "";
        const citations: AiCitation[] = [];
        for (const cite of Array.isArray(point.cite) ? point.cite.slice(0, 4) : []) {
          const entry = (cite ?? {}) as Record<string, unknown>;
          const key = `${typeof entry.file === "string" ? entry.file.trim() : ""}:${typeof entry.line === "number" ? Math.trunc(entry.line) : NaN}`;
          const sent = sentLines.get(key);
          if (sent) {
            citations.push({ uri: sent.uri, label: sent.label, line: Number(key.slice(key.lastIndexOf(":") + 1)) - 1, excerpt: sent.text.trim().slice(0, 140) });
          } else {
            dropped += 1;
          }
        }
        return { text: pointText, citations };
      })
      .filter((point) => point.text.length > 0);

  const byPath = new Map(projectFiles.map((file) => [file.path, file.uri]));
  const parts: ProjectPart[] = [];
  for (const raw of Array.isArray(record.parts) ? record.parts.slice(0, 8) : []) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const path = typeof entry.file === "string" ? entry.file.trim().replace(/^\.?\//, "") : "";
    const role = typeof entry.role === "string" ? entry.role.trim().slice(0, 240) : "";
    if (path && role && byPath.has(path) && !parts.some((part) => part.path === path)) {
      parts.push({ path, uri: byPath.get(path), role });
    }
  }

  const fit = record.selectionFit && typeof record.selectionFit === "object" ? (record.selectionFit as Record<string, unknown>) : undefined;
  const fitText = fit && typeof fit.text === "string" ? fit.text.trim().slice(0, 900) : "";
  const optional = (value: unknown, max: number): string | undefined =>
    typeof value === "string" && value.trim() && value.trim().toLowerCase() !== "null" ? value.trim().slice(0, max) : undefined;

  return {
    status: "ok",
    model,
    summary: summary.slice(0, 1400),
    purpose: optional(record.purpose, 300),
    howItWorks: points(record.howItWorks, 7),
    parts,
    selectionFit: fitText ? { text: fitText, steps: points(fit?.steps, 6) } : undefined,
    startHere: optional(record.startHere, 300),
    droppedCitations: dropped,
    filesSent: [...filesSent],
  };
}
