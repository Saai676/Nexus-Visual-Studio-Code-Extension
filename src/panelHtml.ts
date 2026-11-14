/**
 * Turns an Explanation into the HTML shown in the Nexus panel.
 *
 * Pure string building with no VS Code imports, so it can be tested
 * and previewed outside the editor. All text is escaped; the only
 * script is the small, nonce-protected navigation/AI handler.
 */
import type { AiResult } from "./aiPrompt";
import type {
  Basis,
  BreakdownPart,
  Claim,
  Evidence,
  Explanation,
  MapNode,
  Rich,
} from "./analysis/explanationModel";

export interface PanelRenderOptions {
  readonly nonce: string;
  readonly cspSource: string;
  /** Short, display-friendly file path. */
  readonly displayPath: string;
  readonly aiEnabled: boolean;
  readonly followCursor: boolean;
}

const BASIS_LABEL: Readonly<Record<Basis, string>> = {
  source: "seen in file",
  provider: "language server",
  language: "language rule",
  "name-match": "name match",
};

const BASIS_TITLE: Readonly<Record<Basis, string>> = {
  source: "Read directly in the source code, at an exact location.",
  provider: "Reported by VS Code's language server for this language.",
  language: "A general rule of the programming language, not something specific to this project.",
  "name-match": "The same spelling appears. That is NOT proof it is the same thing.",
};

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character,
  );
}

function rich(text: Rich): string {
  return text
    .map((part) => (typeof part === "string" ? escapeHtml(part) : `<code>${escapeHtml(part.code)}</code>`))
    .join("");
}

function tag(basis: Basis | "ai"): string {
  if (basis === "ai") {
    return `<span class="tag tag-ai" title="Written by an AI model from files in this workspace. Check the cited lines.">AI</span>`;
  }
  return `<span class="tag tag-${basis}" title="${escapeHtml(BASIS_TITLE[basis])}">${escapeHtml(BASIS_LABEL[basis])}</span>`;
}

function evidenceLinks(ids: readonly string[], evidence: ReadonlyMap<string, Evidence>): string {
  const links = ids
    .map((id) => evidence.get(id))
    .filter((entry): entry is Evidence => entry !== undefined)
    .slice(0, 4)
    .map((entry) => `<button class="jump" type="button" data-evidence-id="${escapeHtml(entry.id)}" title="${escapeHtml(entry.label)}: ${escapeHtml(entry.excerpt)}">${escapeHtml(lineLabel(entry))}</button>`);
  return links.length > 0 ? `<span class="jumps">${links.join("")}</span>` : "";
}

function lineLabel(entry: Evidence): string {
  return `${shortFile(entry.uri)}:${entry.range.start.line + 1}`;
}

function shortFile(uri: string): string {
  const path = uri.replace(/[?#].*$/, "");
  try {
    return decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
  } catch {
    return path.slice(path.lastIndexOf("/") + 1);
  }
}

function claims(list: readonly Claim[], evidence: ReadonlyMap<string, Evidence>, cls = "claims"): string {
  return `<ul class="${cls}">${list
    .map((entry) => `<li>${tag(entry.basis)}<span class="claim-text">${rich(entry.text)}</span>${evidenceLinks(entry.evidenceIds, evidence)}</li>`)
    .join("")}</ul>`;
}

function section(id: string, icon: string, title: string, body: string, extraClass = ""): string {
  return `<section class="card ${extraClass}" id="${id}"><h2><span class="icon" aria-hidden="true">${icon}</span>${escapeHtml(title)}</h2>${body}</section>`;
}

function breakdown(parts: readonly BreakdownPart[], truncated: boolean): string {
  if (parts.length === 0) {
    return "";
  }
  const chips = parts
    .map((part, index) => {
      const label = part.label ? `<span class="chip-label">${escapeHtml(part.label)}</span>` : `<span class="chip-label chip-label-empty">&nbsp;</span>`;
      const describedBy = part.detail ? ` data-legend="${index}" tabindex="0"` : "";
      return `<span class="chip chip-${part.role}${part.focus ? " chip-focus" : ""}"${describedBy}><span class="chip-code">${escapeHtml(part.text)}</span>${label}</span>`;
    })
    .join("");

  const seen = new Set<string>();
  const legend = parts
    .map((part, index) => ({ part, index }))
    .filter(({ part }) => {
      if (!part.detail) {
        return false;
      }
      const key = `${part.role}|${part.text}|${part.label}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .map(({ part, index }) => `<li data-legend-item="${index}"><span class="legend-swatch swatch-${part.role}"></span><span>${rich(part.detail!)}</span></li>`)
    .join("");

  return `<div class="chips" role="list">${chips}</div>${truncated ? `<p class="muted small">Long expression: only the first part is broken down.</p>` : ""}<ul class="legend">${legend}</ul>`;
}

function mapColumn(nodes: readonly MapNode[], column: MapNode["column"], title: string): string {
  const items = nodes
    .filter((node) => node.column === column)
    .map((node) => {
      const label = node.code ? `<code>${escapeHtml(node.label)}</code>` : escapeHtml(node.label);
      const inner = `<span class="node-caption">${escapeHtml(node.caption)}</span><span class="node-label">${label}</span><span class="node-basis basis-dot-${node.basis}" title="${escapeHtml(BASIS_TITLE[node.basis])}"></span>`;
      return node.evidenceId
        ? `<button type="button" class="node node-${column} node-basis-${node.basis}" data-evidence-id="${escapeHtml(node.evidenceId)}">${inner}</button>`
        : `<div class="node node-${column} node-basis-${node.basis}">${inner}</div>`;
    })
    .join("");
  return `<div class="map-col map-col-${column}"><div class="map-col-title">${escapeHtml(title)}</div>${items}</div>`;
}

function conceptMap(nodes: readonly MapNode[]): string {
  if (nodes.length === 0) {
    return "";
  }
  return `<div class="map">${mapColumn(nodes, "origin", "Comes from")}<div class="map-arrow" aria-hidden="true">→</div>${mapColumn(nodes, "focus", "You selected")}<div class="map-arrow" aria-hidden="true">→</div>${mapColumn(nodes, "usage", "Used for")}</div>
<p class="muted small map-key"><span class="basis-dot-source"></span> seen in file <span class="basis-dot-provider"></span> language server <span class="basis-dot-language"></span> language rule <span class="basis-dot-name-match"></span> name match only</p>`;
}

export function renderAiResult(result: AiResult | undefined, enabled: boolean): string {
  if (!enabled) {
    return `<p class="muted">Want a plain-English summary of what this does in your project? Turn on <button type="button" class="link" data-command="enableAi">AI summaries</button>. The AI only sees files from this workspace, never the web.</p>`;
  }
  if (!result) {
    return `<div class="ai-loading"><span class="spinner" aria-hidden="true"></span>Reading the related files in this project…</div>`;
  }
  if (result.status !== "ok") {
    return `<p class="muted">${escapeHtml(result.message)}</p>`;
  }

  const points = result.points
    .map((point) => {
      const cites = point.citations
        .map((cite, index) => `<button type="button" class="jump" data-ai-cite="${escapeHtml(cite.uri)}|${cite.line}" title="${escapeHtml(cite.excerpt)}">${escapeHtml(cite.label)}:${cite.line + 1}</button>${index < point.citations.length - 1 ? "" : ""}`)
        .join("");
      return `<li>${escapeHtml(point.text)}${cites ? `<span class="jumps">${cites}</span>` : `<span class="muted small"> (no line cited)</span>`}</li>`;
    })
    .join("");

  return `<p class="ai-summary">${escapeHtml(result.summary)}</p>
${result.role ? `<p class="ai-role"><strong>Its role in the project:</strong> ${escapeHtml(result.role)}</p>` : ""}
${points ? `<ul class="ai-points">${points}</ul>` : ""}
<p class="muted small">Written by ${escapeHtml(result.model)} using only: ${escapeHtml(result.filesSent.join(", "))}. AI can be wrong. Check the cited lines.${result.droppedCitations > 0 ? ` ${result.droppedCitations} citation${result.droppedCitations === 1 ? " was" : "s were"} removed because ${result.droppedCitations === 1 ? "it did" : "they did"} not match the code that was sent.` : ""}</p>`;
}

export function renderPanel(explanation: Explanation, options: PanelRenderOptions): string {
  const evidence = new Map(explanation.evidence.map((entry) => [entry.id, entry]));
  const body = explanation.hasContent ? renderBody(explanation, evidence, options) : `<section class="card empty"><h1>Nothing to explain here</h1><p>${escapeHtml(explanation.emptyMessage ?? "")}</p></section>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${options.nonce}'; script-src 'nonce-${options.nonce}';" />
<title>Nexus</title>
<style nonce="${options.nonce}">${STYLES}</style>
</head>
<body>
<main>
${body}
</main>
<script nonce="${options.nonce}">${SCRIPT}</script>
</body>
</html>`;
}

function renderBody(explanation: Explanation, evidence: ReadonlyMap<string, Evidence>, options: PanelRenderOptions): string {
  const parts: string[] = [];

  parts.push(`<header class="hero">
  <div class="hero-top">
    <span class="pill">${escapeHtml(explanation.kindLabel)}</span>
    <span class="pill pill-quiet">${escapeHtml(explanation.languageLabel)}</span>
    <span class="spacer"></span>
    <button type="button" class="toggle${options.followCursor ? " on" : ""}" data-command="toggleFollow" title="Update this panel automatically as you move the cursor">${options.followCursor ? "● Following cursor" : "○ Follow cursor"}</button>
  </div>
  <h1><code>${escapeHtml(explanation.heading)}</code></h1>
  <p class="muted small">${escapeHtml(options.displayPath)} · line ${explanation.range.start.line + 1}</p>
</header>`);

  parts.push(section("meaning", "💡", "What this means", claims(explanation.meaning, evidence, "claims claims-lead"), "card-lead"));

  parts.push(section("ai", "✨", "AI summary: what it does in this project", `<div id="ai-body">${renderAiResult(undefined, options.aiEnabled)}</div>`, "card-ai"));

  if (explanation.breakdown.length > 0) {
    parts.push(section("syntax", "🧩", "Read it piece by piece", breakdown(explanation.breakdown, explanation.breakdownTruncated)));
  }

  if (explanation.map.nodes.length > 0) {
    parts.push(section("map", "🗺️", "How it connects", conceptMap(explanation.map.nodes)));
  }

  if (explanation.flow) {
    const rows = explanation.flow.rows
      .map((row) => `<div class="flow-row flow-${row.tone}"><span class="flow-tag">${escapeHtml(row.tag)}</span><span class="flow-text">${rich(row.text)}</span></div>`)
      .join("");
    parts.push(section("flow", "🔀", explanation.flow.title, `<div class="flow">${rows}</div><p class="muted small">${tag("language")} This is how the language works in general, not proof that this code runs.</p>`));
  }

  if (explanation.fits.length > 0) {
    parts.push(section("fits", "📄", "How it fits into this file", claims(explanation.fits, evidence)));
  }

  if (explanation.whatIf.length > 0) {
    const cards = explanation.whatIf
      .map((entry) => `<div class="whatif">${tag(entry.basis)}<div class="whatif-change">${rich(entry.change)}…</div><div class="whatif-effect">→ ${rich(entry.effect)}</div>${evidenceLinks(entry.evidenceIds, evidence)}</div>`)
      .join("");
    parts.push(section("whatif", "🔧", "If you change this…", `<div class="whatifs">${cards}</div>`));
  }

  if (explanation.project.length > 0) {
    parts.push(section("project", "🧭", "In the rest of the project", claims(explanation.project, evidence)));
  }

  if (explanation.documentation.length > 0) {
    const docs = explanation.documentation
      .map((entry) => `<details><summary>Documentation for <code>${escapeHtml(entry.subject)}</code> ${tag("provider")}</summary><pre class="doc">${escapeHtml(entry.text)}${entry.truncated ? "\n…" : ""}</pre></details>`)
      .join("");
    parts.push(section("docs", "📘", "Documentation from the language server", docs));
  }

  if (explanation.unknowns.length > 0) {
    parts.push(section("unknowns", "❓", "What Nexus can't tell you", `<ul class="unknowns">${explanation.unknowns.map((entry) => `<li>${rich(entry)}</li>`).join("")}</ul>`, "card-unknown"));
  }

  const glossary = explanation.glossary.length > 0
    ? `<details><summary>Words used here (${explanation.glossary.length})</summary><dl class="glossary">${explanation.glossary.map((entry) => `<dt>${escapeHtml(entry.term)}</dt><dd>${escapeHtml(entry.plain)}</dd>`).join("")}</dl></details>`
    : "";
  const evidenceList = explanation.evidence.length > 0
    ? `<details><summary>All evidence (${explanation.evidence.length})</summary><ul class="evidence">${explanation.evidence
        .map((entry) => `<li><button type="button" class="evidence-row" data-evidence-id="${escapeHtml(entry.id)}">${tag(entry.basis)}<span class="evidence-label">${escapeHtml(entry.label)}</span><span class="evidence-loc">${escapeHtml(lineLabel(entry))}</span>${entry.excerpt ? `<code class="evidence-excerpt">${escapeHtml(entry.excerpt)}</code>` : ""}</button></li>`)
        .join("")}</ul></details>`
    : "";
  const status = explanation.providerStatus.length > 0
    ? `<details><summary>Language server status</summary><ul class="plain">${explanation.providerStatus
        .map((line) => `<li><strong>${escapeHtml(line.label)}:</strong> ${escapeHtml(line.status)} (${line.count})${line.message ? ` · <span class="muted">${escapeHtml(line.message)}</span>` : ""}</li>`)
        .join("")}</ul></details>`
    : "";
  const limits = [...explanation.limits];
  const limitsHtml = limits.length > 0 ? `<details${explanation.supportLevel === "generic" ? " open" : ""}><summary>Limits of this explanation (${limits.length})</summary><ul class="plain">${limits.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")}</ul></details>` : "";

  parts.push(`<section class="card card-quiet" id="more"><h2><span class="icon" aria-hidden="true">🔎</span>Check the evidence</h2>${evidenceList}${glossary}${limitsHtml}${status}</section>`);

  return parts.join("\n");
}

const STYLES = `
:root{color-scheme:light dark;--fg:var(--vscode-foreground);--muted:var(--vscode-descriptionForeground);--bg:var(--vscode-editor-background);--card:var(--vscode-sideBar-background,var(--bg));--border:var(--vscode-panel-border,rgba(128,128,128,.3));--accent:var(--vscode-textLink-foreground);--focus:var(--vscode-focusBorder);
--c-name:#4f9cf9;--c-member:#b184f5;--c-keyword:#f08a5d;--c-text:#52c47a;--c-number:#e3b341;--c-access:#8b949e;--c-call:#e06c9f;--c-operator:#56c2c2;
--b-source:#3fb950;--b-provider:#58a6ff;--b-language:#d2a8ff;--b-name-match:#d29922;--b-ai:#f778ba}
*{box-sizing:border-box}
body{margin:0;padding:14px 16px 32px;color:var(--fg);background:var(--bg);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);line-height:1.55}
main{max-width:860px;margin:0 auto}
h1{font-size:1.25em;margin:6px 0 2px;overflow-wrap:anywhere;font-weight:600}
h1 code{font-size:1em;background:none;padding:0}
h2{font-size:1em;margin:0 0 10px;display:flex;align-items:center;gap:8px;font-weight:600}
.icon{font-size:1.05em}
code{font-family:var(--vscode-editor-font-family);font-size:.93em;background:var(--vscode-textCodeBlock-background,rgba(128,128,128,.15));padding:1px 5px;border-radius:4px;overflow-wrap:anywhere}
.muted{color:var(--muted)}.small{font-size:.86em}
.hero{padding:4px 2px 12px;border-bottom:1px solid var(--border);margin-bottom:12px}
.hero-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.spacer{flex:1}
.pill{background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:999px;padding:1px 10px;font-size:.82em;font-weight:600}
.pill-quiet{background:transparent;border:1px solid var(--border);color:var(--muted)}
.toggle{font:inherit;font-size:.82em;background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:999px;padding:2px 10px;cursor:pointer}
.toggle.on{color:var(--fg);border-color:var(--accent)}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:12px}
.card-lead{border-left:4px solid var(--accent)}
.card-lead .claims-lead li{font-size:1.05em}
.card-ai{border-left:4px solid var(--b-ai)}
.card-unknown{border-left:4px solid var(--b-name-match)}
.card-quiet{background:transparent}
.claims,.unknowns,.plain,.ai-points{margin:0;padding:0;list-style:none}
.claims li{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 8px;padding:6px 0;border-top:1px dashed var(--border)}
.claims li:first-child{border-top:none;padding-top:0}
.claim-text{flex:1 1 300px}
.unknowns li{padding:4px 0 4px 22px;position:relative}.unknowns li::before{content:"?";position:absolute;left:2px;top:4px;width:14px;height:14px;border-radius:50%;background:var(--b-name-match);color:#000;font-size:.72em;font-weight:700;display:flex;align-items:center;justify-content:center}
.plain li{padding:3px 0}
.tag{display:inline-block;font-size:.7em;font-weight:700;letter-spacing:.03em;text-transform:uppercase;border-radius:4px;padding:1px 6px;white-space:nowrap;border:1px solid currentColor;cursor:help}
.tag-source{color:var(--b-source)}.tag-provider{color:var(--b-provider)}.tag-language{color:var(--b-language)}.tag-name-match{color:var(--b-name-match)}.tag-ai{color:var(--b-ai)}
.jumps{display:inline-flex;gap:4px;flex-wrap:wrap}
.jump{font:inherit;font-size:.8em;font-family:var(--vscode-editor-font-family);color:var(--accent);background:transparent;border:1px solid var(--border);border-radius:5px;padding:0 6px;cursor:pointer}
.jump:hover,.jump:focus-visible,.node:focus-visible,.evidence-row:focus-visible{border-color:var(--focus);outline:none;background:var(--vscode-list-hoverBackground)}
.link{font:inherit;color:var(--accent);background:none;border:none;padding:0;cursor:pointer;text-decoration:underline}
.chips{display:flex;flex-wrap:wrap;gap:6px 4px;align-items:flex-start;padding:4px 0 10px}
.chip{display:inline-flex;flex-direction:column;align-items:center;border-radius:7px;padding:4px 7px 3px;border:1px solid transparent;cursor:default;min-width:14px}
.chip[data-legend]{cursor:pointer}
.chip-code{font-family:var(--vscode-editor-font-family);font-size:1.05em;white-space:pre}
.chip-label{font-size:.68em;color:var(--muted);margin-top:2px;white-space:nowrap;letter-spacing:.02em}
.chip-label-empty{visibility:hidden}
.chip-name{background:color-mix(in srgb,var(--c-name) 18%,transparent);border-color:color-mix(in srgb,var(--c-name) 50%,transparent)}
.chip-member{background:color-mix(in srgb,var(--c-member) 18%,transparent);border-color:color-mix(in srgb,var(--c-member) 50%,transparent)}
.chip-keyword{background:color-mix(in srgb,var(--c-keyword) 18%,transparent);border-color:color-mix(in srgb,var(--c-keyword) 50%,transparent)}
.chip-text{background:color-mix(in srgb,var(--c-text) 18%,transparent);border-color:color-mix(in srgb,var(--c-text) 50%,transparent)}
.chip-number{background:color-mix(in srgb,var(--c-number) 18%,transparent);border-color:color-mix(in srgb,var(--c-number) 50%,transparent)}
.chip-access{background:color-mix(in srgb,var(--c-access) 14%,transparent)}
.chip-call{background:color-mix(in srgb,var(--c-call) 18%,transparent);border-color:color-mix(in srgb,var(--c-call) 50%,transparent)}
.chip-operator{background:color-mix(in srgb,var(--c-operator) 18%,transparent);border-color:color-mix(in srgb,var(--c-operator) 50%,transparent)}
.chip-plain{padding-left:2px;padding-right:2px}
.chip-focus{box-shadow:0 0 0 2px var(--focus)}
.chip.active{outline:2px solid var(--focus)}
.legend{list-style:none;margin:0;padding:8px 0 0;border-top:1px dashed var(--border);display:grid;gap:5px}
.legend li{display:flex;gap:8px;align-items:baseline;border-radius:5px;padding:1px 4px}
.legend li.active{background:var(--vscode-list-hoverBackground)}
.legend-swatch{width:10px;height:10px;border-radius:3px;flex:none;display:inline-block;margin-top:5px}
.swatch-name{background:var(--c-name)}.swatch-member{background:var(--c-member)}.swatch-keyword{background:var(--c-keyword)}.swatch-text{background:var(--c-text)}.swatch-number{background:var(--c-number)}.swatch-access{background:var(--c-access)}.swatch-call{background:var(--c-call)}.swatch-operator{background:var(--c-operator)}.swatch-plain{background:var(--muted)}
.map{display:grid;grid-template-columns:1fr auto minmax(110px,.8fr) auto 1fr;gap:8px;align-items:center}
.map-col{display:flex;flex-direction:column;gap:6px;min-width:0}
.map-col-title{font-size:.72em;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);text-align:center;font-weight:700}
.map-arrow{font-size:1.5em;color:var(--muted)}
.node{font:inherit;text-align:left;display:flex;flex-direction:column;gap:2px;border:1px solid var(--border);border-radius:8px;padding:6px 9px;background:var(--bg);color:var(--fg);position:relative;min-width:0}
button.node{cursor:pointer}button.node:hover{border-color:var(--focus)}
.node-focus{border:2px solid var(--accent);text-align:center;align-items:center;padding:10px}
.node-focus .node-label{font-size:1.1em}
.node-name-match{border-style:dashed}
.node-caption{font-size:.72em;color:var(--muted)}
.node-label{overflow-wrap:anywhere}
.node-basis{position:absolute;top:6px;right:6px}
[class^="basis-dot-"],[class*=" basis-dot-"]{display:inline-block;width:8px;height:8px;border-radius:50%;margin:0 3px 0 8px}
.basis-dot-source{background:var(--b-source)}.basis-dot-provider{background:var(--b-provider)}.basis-dot-language{background:var(--b-language)}.basis-dot-name-match{background:var(--b-name-match)}
.map-key{margin:10px 0 0}
@media (max-width:560px){.map{grid-template-columns:1fr}.map-arrow{transform:rotate(90deg);justify-self:center}}
.flow{display:flex;flex-direction:column;gap:0;border-radius:8px;overflow:hidden;border:1px solid var(--border)}
.flow-row{display:grid;grid-template-columns:110px 1fr;align-items:stretch}
.flow-row+.flow-row{border-top:1px solid var(--border)}
.flow-tag{font-size:.75em;font-weight:800;letter-spacing:.05em;padding:8px 10px;display:flex;align-items:center}
.flow-text{padding:8px 12px}
.flow-if .flow-tag{background:color-mix(in srgb,var(--c-keyword) 25%,transparent)}
.flow-then .flow-tag{background:color-mix(in srgb,var(--b-source) 25%,transparent)}
.flow-else .flow-tag{background:color-mix(in srgb,var(--b-provider) 22%,transparent)}
.flow-note .flow-tag{background:color-mix(in srgb,var(--b-name-match) 22%,transparent)}
.whatifs{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px}
.whatif{border:1px solid var(--border);border-radius:9px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;background:var(--bg)}
.whatif .tag{align-self:flex-start}
.whatif-change{font-weight:600}
.whatif-effect{color:var(--fg)}
.ai-summary{font-size:1.04em;margin:0 0 8px}
.ai-role{margin:0 0 8px}
.ai-points li{padding:4px 0 4px 16px;position:relative}.ai-points li::before{content:"•";position:absolute;left:3px;color:var(--b-ai)}
.ai-points .jumps{margin-left:6px}
.ai-loading{display:flex;align-items:center;gap:10px;color:var(--muted)}
.spinner{width:14px;height:14px;border-radius:50%;border:2px solid var(--border);border-top-color:var(--b-ai);animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
details{border-top:1px solid var(--border);padding:8px 0}
details:first-of-type{border-top:none}
summary{cursor:pointer;font-weight:600;padding:2px 0}
.glossary{margin:8px 0 0;display:grid;grid-template-columns:max-content 1fr;gap:4px 14px}
.glossary dt{font-weight:600}.glossary dd{margin:0}
.evidence{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:5px}
.evidence-row{font:inherit;width:100%;text-align:left;display:grid;grid-template-columns:auto 1fr auto;gap:2px 8px;align-items:center;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid transparent;border-radius:6px;padding:6px 9px;cursor:pointer}
.evidence-row:hover{border-color:var(--focus)}
.evidence-loc{font-family:var(--vscode-editor-font-family);font-size:.85em;color:var(--accent)}
.evidence-excerpt{grid-column:1/-1;white-space:pre-wrap}
pre.doc{white-space:pre-wrap;font-family:var(--vscode-editor-font-family);font-size:.9em;background:var(--vscode-textCodeBlock-background,rgba(128,128,128,.12));padding:10px;border-radius:6px;max-height:260px;overflow:auto}
.empty h1{font-size:1.1em}
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("[data-evidence-id],[data-ai-cite],[data-command],[data-legend]") : null;
  if (!target) { return; }
  if (target.dataset.evidenceId) { vscode.postMessage({ command: "navigate", evidenceId: target.dataset.evidenceId }); return; }
  if (target.dataset.aiCite) { vscode.postMessage({ command: "navigateAi", cite: target.dataset.aiCite }); return; }
  if (target.dataset.command) { vscode.postMessage({ command: target.dataset.command }); return; }
  if (target.dataset.legend) { highlight(target.dataset.legend); }
});
document.addEventListener("keydown", (event) => {
  const target = event.target;
  if ((event.key === "Enter" || event.key === " ") && target instanceof HTMLElement && target.dataset.legend) { event.preventDefault(); highlight(target.dataset.legend); }
});
function highlight(index) {
  document.querySelectorAll(".chip.active,.legend li.active").forEach((element) => element.classList.remove("active"));
  const chip = document.querySelector('[data-legend="' + index + '"]');
  const item = document.querySelector('[data-legend-item="' + index + '"]');
  if (chip) { chip.classList.add("active"); }
  if (item) { item.classList.add("active"); item.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
}
window.addEventListener("message", (event) => {
  const message = event.data;
  if (message && message.command === "aiResult" && typeof message.html === "string") {
    const body = document.getElementById("ai-body");
    if (body) { body.innerHTML = message.html; }
  }
});
`;
