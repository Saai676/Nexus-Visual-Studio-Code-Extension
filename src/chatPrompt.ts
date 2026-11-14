/**
 * "Ask about this": the chat prompt, the lookup protocol, and answer
 * validation. No VS Code imports, so it is unit-tested.
 *
 * The model can answer, or ask Nexus to look things up first:
 *   - open a project file by its path, or
 *   - search the project for a word.
 * Lookups only ever reach files in the workspace. Citations in the
 * final answer are checked against the lines the model was actually
 * shown; anything else is removed.
 */
import { buildPrompt, type AiCitation, type AiContextFile, type AiRequest } from "./aiPrompt";

export const CHAT_SYSTEM_PROMPT = `You answer a beginner programmer's questions about their codebase inside the Nexus VS Code extension.

Rules you must follow:
1. Use ONLY the numbered source files and search results given to you. Do not use outside knowledge about this specific project and never invent code, files or behaviour you were not shown. Do not mention websites.
2. You may use general programming knowledge to explain syntax and well-known language or library features, and say when you are doing so.
3. If what you were given does not answer the question, you may ask Nexus to look things up (see below). If it still does not answer it, say plainly what the code shown does not tell you.
4. Write simply: short sentences, plain words, explain any technical term. Be thorough but not long-winded. Use short paragraphs or a short list of steps when it helps.
5. Cite the file label and line number for every claim about this project, exactly as numbered.

Reply with JSON only, no markdown fences, in ONE of these two shapes:

To answer:
{"answer": "your answer as plain text; use \\n for new lines", "cite": [{"file": "main.py", "line": 12}], "followUps": ["a short follow-up question the user might ask next"]}

To look things up first (at most 3 items):
{"lookup": [{"open": "path/of/a/project/file.py"}, {"search": "word_to_find"}]}
Only "open" paths from the project file list. Only look things up when you really need to.`;

export interface ChatTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface LookupRequest {
  readonly open: readonly string[];
  readonly search: readonly string[];
}

export interface SearchHit {
  readonly label: string;
  readonly uri: string;
  readonly line: number;
  readonly text: string;
}

export type ChatReply =
  | {
      readonly kind: "answer";
      readonly text: string;
      readonly citations: readonly AiCitation[];
      readonly followUps: readonly string[];
      readonly droppedCitations: number;
    }
  | { readonly kind: "lookup"; readonly request: LookupRequest }
  | { readonly kind: "failed"; readonly message: string };

interface SentLine {
  readonly uri: string;
  readonly label: string;
  readonly text: string;
}

const MAX_HISTORY_TURNS = 8;
const MAX_TURN_CHARACTERS = 1_500;

/**
 * Builds the chat prompt from the investigation context, any extra files
 * and search results Nexus looked up, the conversation so far, and the
 * new question. Returns the lines that were sent, for citation checks.
 */
export function buildChatPrompt(
  base: AiRequest,
  extraFiles: readonly AiContextFile[],
  searchHits: readonly SearchHit[],
  history: readonly ChatTurn[],
  question: string,
  lookupsLeft: number,
): { prompt: string; sentLines: Map<string, SentLine> } {
  const searchFile: AiContextFile[] = [];
  // Search hits become small numbered "files" so they can be cited like any other line.
  const byLabel = new Map<string, SearchHit[]>();
  for (const hit of searchHits) {
    const list = byLabel.get(hit.label) ?? [];
    list.push(hit);
    byLabel.set(hit.label, list);
  }
  for (const [label, hits] of byLabel) {
    for (const hit of hits) {
      searchFile.push({ label, uri: hit.uri, firstLine: hit.line, lines: [hit.text], role: "search result" });
    }
  }

  const { prompt: context, sentLines } = buildPrompt({ ...base, files: [...base.files, ...extraFiles, ...searchFile] });
  const conversation = history
    .slice(-MAX_HISTORY_TURNS)
    .map((turn) => `${turn.role === "user" ? "USER" : "YOU"}: ${turn.text.slice(0, MAX_TURN_CHARACTERS)}`)
    .join("\n");

  const prompt = `${context.replace(/Explain what the selected code does in the context of these files\.\s*$/, "")}
${conversation ? `Conversation so far:\n${conversation}\n` : ""}
The user now asks: ${question.slice(0, 2_000)}
${lookupsLeft > 0 ? `You may ask for lookups ${lookupsLeft} more time${lookupsLeft === 1 ? "" : "s"}.` : "You cannot look anything else up now: answer with what you have."}`;

  return { prompt, sentLines };
}

/** Parses the model's reply into an answer (with checked citations) or a lookup request. */
export function parseChatReply(text: string, sentLines: ReadonlyMap<string, SentLine>, allowLookup: boolean): ChatReply {
  const json = extractJson(text);
  if (!json || typeof json !== "object") {
    // Some models ignore the JSON instruction; accept plain prose as an uncited answer.
    const prose = text.trim();
    return prose.length > 0 && !prose.startsWith("{")
      ? { kind: "answer", text: prose.slice(0, 4_000), citations: [], followUps: [], droppedCitations: 0 }
      : { kind: "failed", message: "The AI answer was not in the expected format." };
  }
  const record = json as Record<string, unknown>;

  if (Array.isArray(record.lookup) && allowLookup) {
    const open: string[] = [];
    const search: string[] = [];
    for (const item of record.lookup.slice(0, 3)) {
      const entry = item as Record<string, unknown>;
      if (typeof entry?.open === "string" && entry.open.trim()) {
        open.push(entry.open.trim().replace(/^\.?\//, ""));
      } else if (typeof entry?.search === "string" && entry.search.trim()) {
        search.push(entry.search.trim().slice(0, 80));
      }
    }
    if (open.length + search.length > 0) {
      return { kind: "lookup", request: { open, search } };
    }
  }

  const answer = typeof record.answer === "string" ? record.answer.trim() : "";
  if (!answer) {
    return { kind: "failed", message: "The AI did not give an answer." };
  }

  let dropped = 0;
  const citations: AiCitation[] = [];
  const seen = new Set<string>();
  for (const cite of Array.isArray(record.cite) ? record.cite.slice(0, 10) : []) {
    const entry = cite as Record<string, unknown>;
    const file = typeof entry?.file === "string" ? entry.file.trim() : "";
    const line = typeof entry?.line === "number" ? Math.trunc(entry.line) : Number.NaN;
    const key = `${file}:${line}`;
    const sent = sentLines.get(key);
    if (sent && !seen.has(key)) {
      seen.add(key);
      citations.push({ uri: sent.uri, label: sent.label, line: line - 1, excerpt: sent.text.trim().slice(0, 140) });
    } else if (!sent) {
      dropped += 1;
    }
  }

  const followUps = (Array.isArray(record.followUps) ? record.followUps : [])
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .slice(0, 3)
    .map((entry) => entry.trim().slice(0, 140));

  return { kind: "answer", text: answer.slice(0, 4_000), citations, followUps, droppedCitations: dropped };
}

/** Finds lines containing a word (whole-word, case-sensitive first, then case-insensitive). */
export function searchLines(
  files: readonly { readonly label: string; readonly uri: string; readonly text: string }[],
  word: string,
  maxHits = 20,
): SearchHit[] {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [new RegExp(`\\b${escaped}\\b`), new RegExp(`\\b${escaped}\\b`, "i")];
  for (const pattern of patterns) {
    const hits: SearchHit[] = [];
    for (const file of files) {
      const lines = file.text.split(/\r?\n/);
      for (let index = 0; index < lines.length && hits.length < maxHits; index += 1) {
        if (lines[index].length <= 400 && pattern.test(lines[index])) {
          hits.push({ label: file.label, uri: file.uri, line: index, text: lines[index] });
        }
      }
      if (hits.length >= maxHits) {
        break;
      }
    }
    if (hits.length > 0) {
      return hits;
    }
  }
  return [];
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
