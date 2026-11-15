# Nexus

A VS Code extension that explains whatever code you select in plain English, visually, and shows you the evidence behind every claim.

## Download & install

Nexus isn't on the VS Code Marketplace yet, so you install it from this GitHub repo. It takes about 5 minutes the first time.

### What you need

| Tool | Check it's installed | Get it |
|---|---|---|
| **VS Code** 1.113 or newer | Code → About Visual Studio Code | [code.visualstudio.com](https://code.visualstudio.com/) |
| **Git** | `git --version` | [git-scm.com](https://git-scm.com/downloads) (macOS: `xcode-select --install`) |
| **Node.js** 18 or newer (comes with npm) | `node --version` and `npm --version` | [nodejs.org](https://nodejs.org/) (LTS version) |

Also make the `code` command work in your terminal: open VS Code → Cmd/Ctrl+Shift+P → **Shell Command: Install 'code' command in PATH**.

### Option 1: Install it like a normal extension (recommended)

Open a terminal (macOS: the **Terminal** app; Windows: **PowerShell**) and run these one at a time:

```bash
# 1. Download the code
git clone https://github.com/Saai676/Nexus-Visual-Studio-Code-Extension.git
cd Nexus-Visual-Studio-Code-Extension

# 2. Install what it needs and build the extension file (creates nexus-<version>.vsix)
npm install
rm -f nexus-*.vsix
npm run package

# 3. Install it into VS Code
code --install-extension nexus-*.vsix --force
```

On **Windows (PowerShell)**, skip the `rm` line and type the real file name instead of `nexus-*.vsix`, e.g. `code --install-extension nexus-0.7.0.vsix --force`.

Then in VS Code press **Cmd/Ctrl+Shift+P** → **Developer: Reload Window**.

Nexus is now installed. Open any project (**File → Open Folder…**) and:

- click on some code → press the 💡 button (or **Cmd/Ctrl+Alt+E**) to explain it
- press **Cmd/Ctrl+Alt+P** (or Cmd/Ctrl+Shift+P → **Nexus: Explain This Project**) for the whole-project view

**Prefer clicking?** After step 2, in VS Code open **Extensions** (Cmd/Ctrl+Shift+X) → **`···`** menu at the top → **Install from VSIX…** → choose the `nexus-<version>.vsix` file in the Nexus folder.

### Getting updates

```bash
cd Nexus-Visual-Studio-Code-Extension
git pull
npm install
rm -f nexus-*.vsix
npm run package
code --install-extension nexus-*.vsix --force
```

Then **Developer: Reload Window**.

### Option 2: Try it without installing (for working on Nexus itself)

Open the Nexus folder in VS Code and press **F5**. A second window titled **[Extension Development Host]** opens with Nexus loaded. Open a project in *that* window. See [Run from source (F5)](#run-from-source-f5) for details.

### Turn on the AI explanations (optional)

Everything works without AI. To add the plain-English AI sections:

1. Settings (Cmd/Ctrl+,) → search **nexus ai** → tick **Nexus › AI: Enabled**.
2. Either sign in to **GitHub Copilot** in VS Code (no key needed), or set **Nexus › AI: Provider** to `gemini` and run **Nexus: Set Gemini API Key**.
3. The first time, Nexus asks before sending any code. The AI only sees files from your workspace.

### Troubleshooting

| You see | What to do |
|---|---|
| `git: command not found` / `npm: command not found` | Install Git / Node.js from the table above, then open a **new** terminal window. |
| `code: command not found` | In VS Code: Cmd/Ctrl+Shift+P → **Shell Command: Install 'code' command in PATH**, then open a new terminal. Or use **Install from VSIX…** instead. |
| *"not compatible with VS Code"* | Update VS Code (Code → Check for Updates). |
| *"command 'nexus.explain' not found"* | Run **Developer: Reload Window**. If you use F5, make sure you're in the **[Extension Development Host]** window. |
| *"Explain This Project"* is missing | You have an older version: repeat **Getting updates** above. |
| F5 says *preLaunchTask … exited with code 127* | VS Code can't find npm. Quit VS Code, open it from a terminal with `code .` inside the Nexus folder, and press F5 again. |
| The panel says *Open a project folder first* | Use **File → Open Folder…** (not just a single file). |

## Use it

1. Open any file and click on (or select) some code.
2. Run **Nexus: Explain This Code**: right-click → *Explain This Code*, press **Cmd+Alt+E** (Mac) / **Ctrl+Alt+E**, or use the 💡 button in the editor title bar.
3. A panel opens beside your code. Click any `file:line` button to jump there.

Turn on **Follow cursor** in the panel to have it update as you click around.

## What the panel shows

Visual first, words second:

| Section | What it is |
|---|---|
| **Headline** | One big line: `st` = short name for `streamlit` |
| Read it left to right | The expression as numbered boxes with arrows: `st` → look inside for `title` → run it with `"…"` |
| The pieces | Each part of the code as a coloured, labelled chip (click a chip for its meaning) |
| How it connects | Concept map: where it comes from → what you selected → what it's used for |
| Where this fits in the project | Zoom path (project › folder › file › function › selection), which files use this file and which it uses, and a map of every source file with related ones highlighted |
| Flowchart | `if` → YES/NO branches; loops → a repeat cycle; `with`, `try`, functions, `return` → steps |
| If you change this | **change → effect** cards |
| How this fits into your project *(AI, optional)* | A thorough plain-English explanation: what it is, its job, what goes in, what comes out, what relies on it, and a step-by-step flow through the project with clickable lines. The AI only sees workspace files (code, file list, README) |
| Explain in words *(folded)* | The full written explanation, project context and documentation |
| What Nexus can't tell you *(folded)* | Honest unknowns |
| Evidence, glossary, limits *(folded)* | Every location used, the words explained, analysis limits |

Evidence tags: **seen in file** (read in source), **language server** (reported by VS Code), **language rule** (general language knowledge), **name match** (same spelling only, not proof), **AI**.

### Explain the whole project

Press **🗺️ Explain the whole project** at the top of the Nexus panel, the 🗺️ button in the editor title bar, right-click a folder in the Explorer, or **Cmd/Ctrl+Alt+P**. It opens a project overview:

- **Where your selection fits**: project › folder › file › selection, plus the chain of imports from where the program starts down to your file
- **What this project is and how it works** *(AI, optional)*: a simple explanation of the whole project, the problem it solves, a step-by-step flow, the main parts, where to start reading, and how your selected code fits in, at your chosen reading level
- **How the files connect**: a diagram with the starting files on the left and each column one import further away; files are tagged *starts here*, *core*, *helper*, *test* or *on its own*
- **Read the project in this order**: a suggested reading tour

The structure (starting files, diagram, tour) comes from the code's own import statements, with no AI involved.

### Explain like I'm…

The AI explanation has a reading-level picker: **🧸 5-year-old**, **🎒 Middle schooler**, **🌱 Beginner coder** (default) and **💻 Developer**. Click one to re-explain the same code at that level; your choice is saved in the `nexus.ai.explainLevel` setting. Only the wording changes. The AI still has to cite real lines and stays inside the workspace.

## Languages

- **Detailed:** Python, JavaScript, TypeScript (incl. JSX/TSX)
- **Basic:** Java, C, C++, C#, Go, Rust
- **Anything else:** names, text, numbers and call syntax, plus whatever the language server provides, clearly labelled as limited.

## AI summaries (off by default)

Settings → `nexus.ai.enabled`. Provider `vscode` uses a model you already have in VS Code (e.g. GitHub Copilot), with no key needed. Provider `gemini` uses your own key (**Nexus: Set Gemini API Key**, stored in VS Code secret storage). The model receives only workspace text and has no web access or tools; citations that don't match lines Nexus actually sent are discarded. Nexus asks once before sending any code.

## Run from source (F5)

1. `git pull`
2. Open the Nexus folder in VS Code and press **F5** (Run → Start Debugging → "Run Nexus Extension").
   F5 installs dependencies and compiles automatically, then opens a second window titled **[Extension Development Host]**.
3. In that new window, open a project (e.g. the Finance repo), click on some code and run **Nexus: Explain This Code**.

If F5 still says *"preLaunchTask … exited with code 127"*, VS Code can't find Node/npm. Quit VS Code, open Terminal, `cd` into the Nexus folder, run `npm install`, then `code .` and press F5 again.

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
