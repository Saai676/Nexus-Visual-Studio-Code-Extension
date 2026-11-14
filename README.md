# Nexus

A VS Code extension that explains whatever code you select in plain English, visually, and shows you the evidence behind every claim.

## Use it

1. Open any file and click on (or select) some code.
2. Run **Nexus: Explain This Code**: right-click → *Explain This Code*, press **Cmd+Alt+E** (Mac) / **Ctrl+Alt+E**, or use the 💡 button in the editor title bar.
3. A panel opens beside your code. Click any `file:line` button to jump there.

Turn on **Follow cursor** in the panel to have it update as you click around.

## What the panel shows

| Section | What it is |
|---|---|
| What this means | 2–3 plain sentences about the selection, each tagged with where it came from |
| AI summary *(optional)* | What the code does in this project, written by an AI that only sees workspace files, with checked line citations |
| Read it piece by piece | The expression split into coloured, labelled chips |
| How it connects | Concept map: where it comes from → what you selected → what it is used for |
| If / then | How an `if`, loop, `with`, `try`, function or `return` steers the program |
| If you change this… | What a rename or a different value would affect, from the code |
| In the rest of the project | The definition in another file, the author's own comment, files that import this one |
| What Nexus can't tell you | Honest unknowns |
| Check the evidence | Every location used, a glossary, limits, raw language-server status |

Evidence tags: **seen in file** (read in source), **language server** (reported by VS Code), **language rule** (general language knowledge), **name match** (same spelling only, not proof), **AI**.

## Languages

- **Detailed:** Python, JavaScript, TypeScript (incl. JSX/TSX)
- **Basic:** Java, C, C++, C#, Go, Rust
- **Anything else:** names, text, numbers and call syntax, plus whatever the language server provides, clearly labelled as limited.

## AI summaries (off by default)

Settings → `nexus.ai.enabled`. Provider `vscode` uses a model you already have in VS Code (e.g. GitHub Copilot), with no key needed. Provider `gemini` uses your own key (**Nexus: Set Gemini API Key**, stored in VS Code secret storage). The model receives only workspace text and has no web access or tools; citations that don't match lines Nexus actually sent are discarded. Nexus asks once before sending any code.

## Develop

```bash
npm install
npm test          # compile + unit tests (no VS Code needed)
# F5 in VS Code → "Run Nexus Extension"
npm run package   # builds nexus-0.2.0.vsix
```

### Architecture

```
src/
  extension.ts          commands, settings, gathers provider evidence, follow-cursor
  symbolInvestigator.ts definition/reference lookups via VS Code providers
  investigationPanel.ts webview lifecycle, message validation, navigation
  panelHtml.ts          Explanation → HTML (pure)
  aiSummary.ts          optional AI call (VS Code LM API or Gemini)
  aiPrompt.ts           prompt + answer validation (pure)
  analysis/             deterministic, VS Code-free analysis
    languageProfiles.ts per-language knowledge (add a language here)
    tokenizer.ts        strings/comments-aware tokenizer
    fileContext.ts      imports, declarations, assignments, occurrences
    selection.ts        what was selected, expression chains, name resolution
    breakdown.ts        syntax chips
    flow.ts             if/then rows
    crossFile.ts        other-file declarations, importers
    explanation.ts      builds the Explanation with evidence + basis tags
```

Nexus never executes repository code, works on the in-memory document (unsaved edits included), and bounds all analysis on large files (it says when it does).
