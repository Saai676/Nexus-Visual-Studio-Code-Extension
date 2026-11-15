/**
 * Tests for the deterministic explanation engine (no VS Code needed).
 * Run with: npm test
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseAnswer, buildPrompt } from "../aiPrompt";
import { findImportsOf, summarizeDeclarationAt } from "../analysis/crossFile";
import { buildExplanation } from "../analysis/explanation";
import { richToPlain, type Explanation } from "../analysis/explanationModel";
import { analyzeSelection } from "../analysis/selection";
import { renderPanel } from "../panelHtml";

const FINANCE = `import streamlit as st

st.title("Financial Data Extraction Tool")

left, right = st.columns(2)

with left:
    st.subheader("News Article")
`;

function explain(text: string, languageId: string, needle: string, length = 0, nth = 0): Explanation {
  let at = -1;
  for (let index = 0; index <= nth; index += 1) {
    at = text.indexOf(needle, at + 1);
  }
  assert.ok(at >= 0, `needle not found: ${needle}`);
  const analysis = analyzeSelection({ text, languageId, selectionStart: at, selectionEnd: at + length });
  return buildExplanation(analysis, "file:///project/main.py", { documentation: [] });
}

const plain = (explanation: Explanation): string =>
  [...explanation.meaning, ...explanation.fits].map((claim) => richToPlain(claim.text)).join("\n");

test("Scenario A: selecting st explains the import alias and links the import line", () => {
  const result = explain(FINANCE, "python", "st.title");
  assert.equal(result.kindLabel, "Import alias");
  assert.match(plain(result), /st is a short name \(an alias\) for streamlit/);
  const aliasClaim = result.meaning[0];
  assert.equal(aliasClaim.basis, "source");
  const evidence = result.evidence.find((entry) => entry.id === aliasClaim.evidenceIds[0]);
  assert.equal(evidence?.range.start.line, 0);
  assert.match(evidence?.excerpt ?? "", /import streamlit as st/);
});

test("Scenario B: st.title(...) explains the whole expression without inventing behaviour", () => {
  const result = explain(FINANCE, "python", 'st.title("Financial Data Extraction Tool")', 41);
  assert.match(plain(result), /look inside it for title, then run it, handing it the text "Financial Data Extraction Tool"/);
  assert.ok(result.unknowns.some((entry) => /What st\.title actually does/.test(richToPlain(entry))));
  assert.deepEqual(result.breakdown.slice(0, 3).map((part) => part.label), ["short for streamlit", "look inside", "thing to run"]);
});

test("Scenario C: st.columns(2) explains member access, call syntax and where the result goes", () => {
  const result = explain(FINANCE, "python", "columns");
  const text = plain(result);
  assert.match(text, /columns is looked up inside st, and st is this file's short name for streamlit/);
  assert.match(text, /handing it the number 2/);
  assert.match(text, /stored in left and right/);
});

test("Scenario D: left inside `with left:` links back to the unpacking assignment", () => {
  const result = explain(FINANCE, "python", "left", 0, 1);
  const text = plain(result);
  assert.match(text, /left is one of 2 names given a value together on line 5/);
  assert.match(text, /left receives the first piece/);
  assert.equal(result.flow?.title, "How the with-block works");
  assert.ok(!/runtime data flow is/.test(text));
});

test("Scenario F: no provider results still produces file-based evidence and honest unknowns", () => {
  const analysis = analyzeSelection({ text: FINANCE, languageId: "python", selectionStart: FINANCE.indexOf("st.title"), selectionEnd: FINANCE.indexOf("st.title") });
  const result = buildExplanation(analysis, "file:///project/main.py", {
    investigation: {
      symbol: { name: "st", origin: "word", sourceUri: "file:///project/main.py", range: { start: { line: 2, character: 0 }, end: { line: 2, character: 2 } }, providerPosition: { line: 2, character: 0 } },
      definitions: [],
      references: [],
      definitionQuery: { status: "no-results", returnedLocationCount: 0, ignoredResultCount: 0 },
      referenceQuery: { status: "no-results", returnedLocationCount: 0, ignoredResultCount: 0 },
      status: "completed",
      limitations: [],
      investigatedAt: "",
    },
    documentation: [],
  });
  assert.match(plain(result), /alias/);
  const unknowns = result.unknowns.map(richToPlain).join("\n");
  assert.match(unknowns, /that does not mean st is undefined/);
  assert.match(unknowns, /does not prove there are none/);
});

test("references never become claims about calls or execution", () => {
  const source = `def helper(x):\n    return x\n\nvalue = helper\nresult = helper(3)\n`;
  const result = explain(source, "python", "helper");
  const text = plain(result);
  assert.match(text, /writes it as a call \(line 5\)/);
  assert.match(text, /not that the line is ever reached/);
  assert.ok(!/is called on line/.test(text));
});

test("matching names in different functions are flagged as name matches, not the same variable", () => {
  const source = `def a():\n    total = 1\n    return total\n\ndef b():\n    total = 2\n    return total\n`;
  const result = explain(source, "python", "total", 0, 1);
  const text = plain(result);
  assert.match(text, /line 2/);
  assert.ok(result.unknowns.some((entry) => /Matching spelling is not proof/.test(richToPlain(entry))));
});

test("keywords are explained as language constructs with if/then flow", () => {
  const source = `def check(n):\n    if n > 0:\n        print("yes")\n    else:\n        print("no")\n`;
  const result = explain(source, "python", "if");
  assert.equal(result.kindLabel, "Keyword");
  const rows = result.flow?.rows.map((row) => `${row.tag}: ${richToPlain(row.text)}`) ?? [];
  assert.deepEqual(rows, ["IF: n > 0 is true", "THEN: line 3 runs", "OTHERWISE: line 5 runs instead"]);
});

test("TypeScript: import alias, function parameters and later uses", () => {
  const source = `import { readFile as rf } from "fs/promises";\nexport async function load(path: string) {\n  const data = await rf(path, "utf8");\n  return data.trim();\n}\n`;
  const alias = explain(source, "typescript", "rf(path");
  assert.match(plain(alias), /rf is a short name \(an alias\) for readFile/);
  const parameter = explain(source, "typescript", "path,");
  assert.equal(parameter.kindLabel, "Parameter (input)");
  assert.match(plain(parameter), /input \(a parameter\) of the function load/);
});

test("Go, Rust and Java imports and declarations are recognised", () => {
  const go = explain(`package main\nimport str "strings"\nfunc main() { str.ToUpper("a") }\n`, "go", "str.ToUpper");
  assert.match(plain(go), /str is a short name \(an alias\) for strings/);
  const rust = explain(`use std::collections::HashMap;\nfn main() { let m = HashMap::new(); }\n`, "rust", "HashMap::new");
  assert.match(plain(rust), /HashMap comes from std::collections/);
  const java = explain(`import java.util.List;\nclass A {\n  int size(List<String> items) { return items.size(); }\n}\n`, "java", "items.size");
  assert.match(plain(java), /items is an input \(a parameter\) of the function size/);
});

test("unknown languages are handled honestly", () => {
  const result = explain(`foo = bar(1)\n`, "elixir", "bar");
  assert.equal(result.supportLevel, "generic");
  assert.ok(result.limits.some((entry) => /no specific knowledge of elixir/.test(entry)));
});

test("strings, comments and blank lines are not mistaken for code", () => {
  const source = `# st is mentioned here\nimport streamlit as st\nx = "st"\n\nst.write(x)\n`;
  const result = explain(source, "python", "st.write");
  assert.match(plain(result), /no other place/);
  const blank = analyzeSelection({ text: source, languageId: "python", selectionStart: source.indexOf("\n\n") + 1, selectionEnd: source.indexOf("\n\n") + 1 });
  assert.equal(buildExplanation(blank, "file:///x.py", { documentation: [] }).hasContent, false);
});

test("large files are analysed in part and say so", () => {
  const filler = "x = 1\n".repeat(150_000);
  const source = `import os\n${filler}value = os.getcwd()\n`;
  const result = explain(source, "python", "os.getcwd");
  assert.match(plain(result), /line 1 imports from os|module that line 1 imports/);
  assert.ok(result.limits.some((entry) => /very large/.test(entry)));
});

test("cross-file: summarises another file's declaration with the author's docstring", () => {
  const other = `def parse(report, strict=False):\n    """Turn a raw earnings report into a dict of figures."""\n    return {}\n`;
  const summary = summarizeDeclarationAt(other, "python", 0);
  assert.equal(summary?.name, "parse");
  assert.deepEqual(summary?.parameters, ["report", "strict"]);
  assert.equal(summary?.authorNote, "Turn a raw earnings report into a dict of figures.");
  assert.deepEqual(findImportsOf(`from app.utils import parse\nimport json\n`, "python", ["utils"]).map((entry) => entry.line), [0]);
});

test("AI answers: citations to lines that were not sent are removed", () => {
  const { sentLines, filesSent } = buildPrompt({
    languageLabel: "Python",
    selectedCode: "st",
    selectionLabel: "main.py",
    selectionLine: 0,
    files: [{ label: "main.py", uri: "file:///main.py", firstLine: 0, lines: FINANCE.split("\n"), role: "the open file" }],
    verifiedFacts: [],
  });
  const answer = JSON.stringify({ summary: "Builds the page header.", role: null, points: [{ text: "Sets the title", cite: [{ file: "main.py", line: 3 }, { file: "main.py", line: 99 }, { file: "web.py", line: 1 }] }] });
  const result = parseAnswer(answer, "test-model", sentLines, filesSent);
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.equal(result.points[0].citations.length, 1);
    assert.equal(result.points[0].citations[0].line, 2);
    assert.equal(result.droppedCitations, 2);
  }
  assert.equal(parseAnswer("not json", "m", sentLines, filesSent).status, "failed");
});

test("panel HTML escapes source text and renders every section", () => {
  const source = `import streamlit as st\nst.markdown("<script>alert(1)</script>")\n`;
  const result = explain(source, "python", "markdown");
  const html = renderPanel(result, { nonce: "abc", cspSource: "x", displayPath: "main.py", aiEnabled: false, followCursor: false });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  for (const heading of ["The pieces", "How it connects", "Explain in words", "What Nexus can't tell you"]) {
    assert.ok(html.includes(heading), heading);
  }
});

test("every explanation has a short one-line headline", () => {
  const cases: [string, string, number, RegExp][] = [
    ["st.title", "python", 0, /^st = short name for streamlit$/],
    ["columns", "python", 0, /^columns = something inside streamlit$/],
    ["left", "python", 1, /^left = the first piece of st\.columns\(2\)$/],
  ];
  for (const [needle, languageId, nth, expected] of cases) {
    assert.match(richToPlain(explain(FINANCE, languageId, needle, 0, nth).headline), expected);
  }
});

test("expressions get a left-to-right step strip", () => {
  const result = explain(FINANCE, "python", "st.title");
  assert.deepEqual(
    result.steps.map((step) => `${step.verb}: ${step.code}`),
    ["start with: st", "look inside for: title", 'run it with: "Financial Data Extraction Tool"'],
  );
});

test("if statements render as a YES/NO flowchart and loops as a repeat cycle", () => {
  const source = `def check(n, items):\n    if n > 0:\n        print("yes")\n    else:\n        print("no")\n    for item in items:\n        print(item)\n`;
  const decision = explain(source, "python", "if");
  assert.equal(decision.flow?.shape, "decision");
  const html = renderPanel(decision, { nonce: "n", cspSource: "x", displayPath: "a.py", aiEnabled: false, followCursor: false });
  assert.ok(html.includes("fc-diamond") && html.includes("✔ YES") && html.includes("✘ NO"));
  const loop = explain(source, "python", "for item");
  assert.equal(loop.flow?.shape, "loop");
  assert.ok(renderPanel(loop, { nonce: "n", cspSource: "x", displayPath: "a.py", aiEnabled: false, followCursor: false }).includes("fc-back"));
});

test("project map: resolves imports between project files and finds who uses the current file", async () => {
  const { buildProjectGraph, buildMapView } = await import("../analysis/projectMap");
  const files = [
    { path: "main.py", uri: "file:///p/main.py", languageId: "python", text: "from app.utils import parse\nimport app.report as rep\nimport streamlit as st\n" },
    { path: "app/utils.py", uri: "file:///p/app/utils.py", languageId: "python", text: "from .report import build\n\ndef parse(x):\n    return build(x)\n" },
    { path: "app/report.py", uri: "file:///p/app/report.py", languageId: "python", text: "def build(x):\n    return x\n" },
    { path: "web/index.ts", uri: "file:///p/web/index.ts", languageId: "typescript", text: "import { api } from './api';\nimport React from 'react';\n" },
    { path: "web/api.ts", uri: "file:///p/web/api.ts", languageId: "typescript", text: "export const api = 1;\n" },
  ];
  const graph = buildProjectGraph(files, false);
  const edges = graph.edges.map((edge) => `${edge.from}->${edge.to}`).sort();
  assert.deepEqual(edges, ["app/utils.py->app/report.py", "main.py->app/report.py", "main.py->app/utils.py", "web/index.ts->web/api.ts"]);

  const view = buildMapView({ graph, currentPath: "app/utils.py", projectName: "p", enclosing: ["function parse"], selectionLabel: "build(x)", definitionPaths: ["app/report.py"], referencePaths: [] });
  assert.deepEqual(view.usedBy.map((entry) => entry.path), ["main.py"]);
  assert.deepEqual(view.uses.map((entry) => entry.path), ["app/report.py"]);
  assert.deepEqual(view.zoom.map((step) => step.label), ["p", "app", "utils.py", "function parse", "build(x)"]);
  assert.equal(view.files.find((file) => file.path === "app/report.py")?.role, "definition");
});

test("AI answers: thorough fields (flow steps, inputs, outputs, dependents) are parsed and checked", () => {
  const { sentLines, filesSent } = buildPrompt({
    languageLabel: "Python",
    selectedCode: "st",
    selectionLabel: "main.py",
    selectionLine: 0,
    files: [{ label: "main.py", uri: "file:///main.py", firstLine: 0, lines: FINANCE.split("\n"), role: "the open file" }],
    verifiedFacts: [],
    projectFiles: ["main.py", "app/utils.py"],
  });
  const answer = JSON.stringify({
    summary: "st is the Streamlit module under a short name. It is used to draw every part of the page.",
    role: "It builds the whole user interface.",
    flow: [{ text: "Line 1 loads Streamlit as st", cite: [{ file: "main.py", line: 1 }] }, { text: "Line 3 draws the title", cite: [{ file: "main.py", line: 3 }] }],
    inputs: "The streamlit library",
    outputs: "The page the user sees",
    dependsOnIt: "Every UI line in main.py",
    points: [],
  });
  const result = parseAnswer(answer, "m", sentLines, filesSent);
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.equal(result.flow.length, 2);
    assert.equal(result.flow[1].citations[0].line, 2);
    assert.equal(result.outputs, "The page the user sees");
  }
});

test("AI reading levels: the prompt asks for the chosen level and the panel shows the picker", async () => {
  const { buildPrompt: build, EXPLAIN_LEVELS } = await import("../aiPrompt");
  const base = { languageLabel: "Python", selectedCode: "st", selectionLabel: "main.py", selectionLine: 0, files: [], verifiedFacts: [] };
  assert.match(build({ ...base, level: "five" }).prompt, /talking to a 5-year-old/);
  assert.match(build({ ...base, level: "middle" }).prompt, /middle-school student/);
  assert.match(build(base).prompt, /someone who is learning to program/);
  assert.equal(EXPLAIN_LEVELS.length, 4);

  const html = renderPanel(explain(FINANCE, "python", "st.title"), { nonce: "n", cspSource: "x", displayPath: "main.py", aiEnabled: true, followCursor: false, explainLevel: "middle" });
  assert.ok(html.includes('data-level="five"') && /class="level on" data-level="middle"/.test(html));
  const off = renderPanel(explain(FINANCE, "python", "st.title"), { nonce: "n", cspSource: "x", displayPath: "main.py", aiEnabled: false, followCursor: false });
  assert.ok(!off.includes("data-level="));
});
