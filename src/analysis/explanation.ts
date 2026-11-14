/**
 * Builds the beginner-facing explanation for one selection.
 *
 * Input:  what the file shows (SelectionAnalysis) plus whatever the
 *         language providers reported.
 * Output: an Explanation whose every claim is tagged with its basis
 *         and linked to evidence the reader can open.
 *
 * No AI is involved. Every sentence comes from a fixed rule applied to
 * evidence, so the same code always produces the same explanation.
 */
import type {
  ProviderDocumentation,
  SourceRange,
  SymbolInvestigation,
} from "../investigationModel";
import { buildBreakdown } from "./breakdown";
import type { DeclarationSummary } from "./crossFile";
import {
  c,
  r,
  type Basis,
  type Claim,
  type Evidence,
  type Explanation,
  type GlossaryEntry,
  type MapNode,
  type ProviderStatusLine,
  type CodeSpan,
  type Rich,
  type Step,
  type WhatIf,
} from "./explanationModel";
import {
  enclosingDeclaration,
  findOccurrences,
  type Assignment,
  type FileContext,
  type Occurrence,
} from "./fileContext";
import { buildFlow } from "./flow";
import { describeSupport } from "./languageProfiles";
import {
  calleeIndex,
  resolveName,
  sourceText,
  type Chain,
  type NameOrigin,
  type SelectionAnalysis,
} from "./selection";
import { formatLineList, ordinal, plural, shorten } from "./text";
import { stringContent } from "./tokenizer";

/** A declaration in another file that the language server pointed at. */
export interface DefinitionContext {
  readonly uri: string;
  readonly range: SourceRange;
  readonly summary: DeclarationSummary;
}

/** Another file whose import statement names this file. */
export interface ImporterContext {
  readonly uri: string;
  readonly line: number;
  readonly excerpt: string;
}

export interface ProviderEvidence {
  readonly investigation?: SymbolInvestigation;
  readonly documentation: readonly ProviderDocumentation[];
  readonly definitionContexts?: readonly DefinitionContext[];
  readonly importers?: readonly ImporterContext[];
  /** How many files were scanned for importers, and whether the scan hit its limit. */
  readonly importerScan?: { readonly filesScanned: number; readonly limited: boolean };
}

const MAX_MAP_NODES_PER_COLUMN = 5;

/** Statements worth describing as a whole when the selection sits inside one. */
const STATEMENT_KEYWORDS = new Set([
  "if", "elif", "else", "for", "foreach", "while", "do", "with", "try", "except", "catch", "finally",
  "return", "def", "function", "fn", "func", "class", "switch", "match", "defer", "go", "yield",
  "raise", "throw", "assert", "loop",
]);

export function buildExplanation(
  analysis: SelectionAnalysis,
  uri: string,
  provider: ProviderEvidence,
): Explanation {
  const { context } = analysis;
  const profile = context.profile;

  if (analysis.focusIndex === -1) {
    return emptyExplanation(profile.label, describeSupport(profile), profile.support, uri);
  }

  const focus = context.tokens[analysis.focusIndex];
  const name = focus.text;
  const focusRange = context.lines.rangeOf(focus.start, focus.end);

  // --- evidence registry ----------------------------------------------------
  const evidence: Evidence[] = [];
  const evidenceKeys = new Map<string, string>();
  const addEvidence = (basis: Basis, label: string, range: SourceRange, evidenceUri = uri, excerpt?: string): string => {
    const key = `${basis}|${evidenceUri}|${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
    const existing = evidenceKeys.get(key);
    if (existing) {
      return existing;
    }
    const id = `e${evidence.length + 1}`;
    evidenceKeys.set(key, id);
    evidence.push({
      id,
      basis,
      label,
      uri: evidenceUri,
      range,
      excerpt: shorten(excerpt ?? (evidenceUri === uri ? context.lines.lineText(range.start.line) : ""), 140),
    });
    return id;
  };

  const meaning: Claim[] = [];
  const fits: Claim[] = [];
  const project: Claim[] = [];
  const whatIf: WhatIf[] = [];
  const unknowns: Rich[] = [];
  const mapNodes: MapNode[] = [];
  const glossary = new Map<string, string>();
  const limits: string[] = [];
  const claim = (list: Claim[], basis: Basis, text: Rich, ...ids: (string | undefined)[]): void => {
    list.push({ text, basis, evidenceIds: ids.filter((id): id is string => id !== undefined) });
  };
  const node = (column: MapNode["column"], caption: string, label: string, basis: Basis, evidenceId?: string, code = true): void => {
    mapNodes.push({ id: `n${mapNodes.length + 1}`, column, caption, label: shorten(label, 34), basis, evidenceId, code });
  };
  const define = (term: string, plain: string): void => {
    glossary.set(term, plain);
  };

  const selectionId = addEvidence("source", "What you selected", focusRange);
  const isName = analysis.focusKind === "name" || analysis.focusKind === "member";
  const origin: NameOrigin = analysis.focusKind === "name" ? resolveName(context, name, focus.line) : { kind: "unknown" };
  const search = isName ? findOccurrences(context, name) : { occurrences: [], total: 0, limited: false };
  const occurrences = search.occurrences;
  const sameKind = occurrences.filter((occurrence) => (analysis.focusKind === "member" ? occurrence.role === "member" : occurrence.role !== "member" && occurrence.role !== "keyword-argument" && occurrence.role !== "property-key"));
  const otherUses = sameKind.filter((occurrence) => !(occurrence.range.start.line === focusRange.start.line && occurrence.range.start.character === focusRange.start.character) && occurrence.role !== "introduction");
  const errorName = profile.family === "python" ? "a NameError" : profile.family === "javascript" ? "a ReferenceError" : "an error";
  let kindLabel = "Code";
  let headline: Rich | undefined;
  const short = (value: string, max = 36): CodeSpan => c(shorten(value, max));
  let originEvidence: string | undefined;

  // --- 1. what the focus is ---------------------------------------------------
  switch (analysis.focusKind) {
    case "keyword": {
      const info = profile.keywords[name];
      kindLabel = "Keyword";
      claim(meaning, "language", r`${c(name)} is a ${profile.label} keyword (${info.term}). ${info.plain}`);
      headline = r`${c(name)} → ${firstSentence(info.plain)}`;
      define(info.term, info.plain);
      break;
    }
    case "string": {
      kindLabel = "Text";
      headline = r`A piece of text: ${short(stringContent(name), 50)}`;
      claim(meaning, "language", r`This is a piece of text, called a string. The program uses these exact characters: ${c(shorten(stringContent(name), 60))}.`, selectionId);
      define("String", "A piece of text written inside quotes.");
      whatIf.push({
        change: r`If you changed this text`,
        effect: r`Whatever receives this text gets the new text instead.`,
        basis: "language",
        evidenceIds: [selectionId],
      });
      break;
    }
    case "number":
      kindLabel = "Number";
      headline = r`The number ${c(name)}`;
      claim(meaning, "language", r`${c(name)} is a number written directly in the code.`, selectionId);
      break;
    case "symbol":
      kindLabel = "Symbol";
      headline = r`The symbol ${c(name)}`;
      claim(meaning, "language", r`${c(name)} is punctuation or an operator. The breakdown below says what each symbol on this line does.`);
      break;
    case "member": {
      kindLabel = "Member";
      const owner = context.tokens[analysis.focusIndex - 2];
      const ownerName = owner && (owner.kind === "identifier" || owner.kind === "keyword") ? owner.text : undefined;
      define("Member access", "Using a dot to reach something that lives inside something else, like a function inside a module.");

      if (!ownerName) {
        claim(meaning, "language", r`${c(name)} is looked up inside the result of the expression before the dot.`, selectionId);
        node("origin", "looked up inside", "the expression before it", "language", undefined, false);
        break;
      }

      kindLabel = `Member of ${shorten(ownerName, 16)}`;
      const ownerOrigin = resolveName(context, ownerName, focus.line);
      if (ownerName === "self" || ownerName === "this") {
        claim(meaning, "language", r`${c(name)} belongs to the current object: ${c(ownerName)} means “the object this code is working on”.`, selectionId);
        headline = r`${c(name)} = something stored on this object`;
        const method = context.declarations.find((declaration) => declaration.name === name && declaration.kind === "method");
        if (method) {
          const id = addEvidence("source", "Method declaration", method.nameRange);
          claim(meaning, "name-match", r`This file declares a method named ${c(name)} on line ${method.line + 1}. Same spelling; Nexus has not proven it is the one used here.`, id);
          node("origin", "method with this name", method.headerText, "name-match", id);
        }
        node("origin", "belongs to", `${ownerName} (current object)`, "language");
      } else if (ownerOrigin.kind === "import") {
        const binding = ownerOrigin.binding;
        const id = addEvidence("source", "Import statement", binding.statementRange);
        originEvidence = id;
        claim(
          meaning,
          "source",
          binding.isAlias
            ? r`${c(name)} is looked up inside ${c(ownerName)}, and ${c(ownerName)} is this file's short name for ${c(binding.importedName)} (line ${binding.line + 1}). So ${c(name)} is something ${c(binding.importedName)} provides.`
            : r`${c(name)} is looked up inside ${c(ownerName)}, which line ${binding.line + 1} imports from ${c(binding.module)}. So ${c(name)} is something that import provides.`,
          id,
        );
        headline = r`${c(name)} = something inside ${short(binding.isAlias ? binding.importedName : binding.module)}`;
        node("origin", "looked up inside", ownerName, "source", selectionId);
        node("origin", binding.isAlias ? `${ownerName} is short for` : `${ownerName} imported from`, binding.isAlias ? binding.importedName : binding.module, "source", id);
        unknowns.push(r`What ${c(name)} does inside ${c(binding.isAlias ? binding.importedName : binding.module)}. That code lives outside this file and Nexus has not read it.`);
      } else {
        claim(meaning, "language", r`${c(name)} is looked up inside ${c(ownerName)}. What it is depends on what ${c(ownerName)} holds.`, selectionId);
        headline = r`${c(name)} = something inside ${short(ownerName)}`;
        node("origin", "looked up inside", ownerName, "source", selectionId);
        const described = describeOrigin(ownerName, ownerOrigin);
        if (described) {
          const id = addEvidence("source", described.label, described.range);
          claim(meaning, "source", described.text, id);
          node("origin", described.caption, described.nodeLabel, "source", id);
        }
      }
      break;
    }
    default: {
      // A plain name.
      define("Name (identifier)", "A word the programmer chose to label something: a variable, function, class or module.");
      switch (origin.kind) {
        case "import": {
          const binding = origin.binding;
          const id = addEvidence("source", "Import statement", binding.statementRange);
          originEvidence = id;
          define("Import", "A line that loads code from another file or package so this file can use it.");
          if (binding.isAlias) {
            kindLabel = "Import alias";
            headline = r`${c(name)} = short name for ${short(binding.importedName)}`;
            define("Alias", "A different, usually shorter, name given to something that was imported.");
            claim(meaning, "source", r`${c(name)} is a short name (an alias) for ${c(binding.importedName)}. Line ${binding.line + 1} says ${c(shorten(binding.statementText, 70))}, so everywhere in this file ${c(name)} means ${c(binding.importedName)}.`, id);
            node("origin", "short name for", binding.importedName, "source", id);
          } else if (binding.form === "default") {
            kindLabel = "Imported (default)";
            headline = r`${c(name)} = the main thing from ${short(binding.module)}`;
            claim(meaning, "source", r`${c(name)} is the main (default) thing exported by ${c(binding.module)}. Line ${binding.line + 1} imports it.`, id);
            node("origin", "default export of", binding.module, "source", id);
          } else if (binding.form === "namespace") {
            kindLabel = "Imported module";
            headline = r`${c(name)} = everything from ${short(binding.module)}`;
            claim(meaning, "source", r`${c(name)} holds everything exported by ${c(binding.module)}. Line ${binding.line + 1} imports it all under this one name.`, id);
            node("origin", "everything from", binding.module, "source", id);
          } else if (binding.form === "module") {
            kindLabel = "Imported module";
            headline = r`${c(name)} = the ${short(binding.module)} module`;
            claim(
              meaning,
              binding.certainty === "explicit" ? "source" : "language",
              binding.certainty === "explicit"
                ? r`${c(name)} is a module that line ${binding.line + 1} imports. Anything written as ${c(`${name}.something`)} comes from that module.`
                : r`${c(name)} is the package imported as ${c(binding.module)} on line ${binding.line + 1}. By convention the package is named after the last part of its path.`,
              id,
            );
            node("origin", "imported module", binding.module, "source", id);
          } else {
            kindLabel = "Imported name";
            headline = r`${c(name)} comes from ${short(binding.module)}`;
            claim(meaning, "source", r`${c(name)} comes from ${c(binding.module)}: line ${binding.line + 1} imports it by name.`, id);
            node("origin", "imported from", binding.module, "source", id);
          }
          unknowns.push(r`What ${c(binding.isAlias ? binding.importedName : name)} contains or does. It lives outside this file and Nexus has not read it.`);
          if (otherUses.length > 0) {
            const lines = otherUses.map((occurrence) => occurrence.line);
            whatIf.push({
              change: r`If you renamed ${c(name)} on the import line`,
              effect: r`${capitalizeFirst(formatLineList(lines))} would break with ${errorName}, because ${otherUses.length === 1 ? "it still says" : "they still say"} ${c(name)}.`,
              basis: "source",
              evidenceIds: [id],
            });
            whatIf.push({
              change: r`If you deleted the import on line ${binding.line + 1}`,
              effect: r`${capitalizeFirst(formatLineList(lines))} would have nothing to point to.`,
              basis: "language",
              evidenceIds: [id],
            });
          }
          break;
        }
        case "declaration": {
          const declaration = origin.declaration;
          const id = addEvidence("source", `${capitalize(declaration.kind)} declaration`, declaration.nameRange);
          originEvidence = id;
          kindLabel = capitalize(declaration.kind);
          const onDeclaration = declaration.line === focus.line;
          const parent = declaration.parent === -1 ? undefined : context.declarations[declaration.parent];
          const inputs = declaration.parameters.map((parameter) => parameter.name);

          if (declaration.kind === "function" || declaration.kind === "method") {
            define("Function", "A named set of steps. It runs only when something calls it.");
            headline = inputs.length === 0 ? r`${c(name)} = a ${declaration.kind} (a reusable set of steps)` : r`${c(name)} = a ${declaration.kind} that takes ${joinCode(inputs.slice(0, 4))}`;
            claim(
              meaning,
              "source",
              r`${c(name)} is a ${declaration.kind}${parent ? r` of ${c(parent.name)}` : ""} ${onDeclaration ? "declared right here" : `declared on line ${declaration.line + 1} of this file`}. ${inputs.length === 0 ? "It takes no listed inputs." : r`It takes ${plural(inputs.length, "input")}: ${joinCode(inputs)}.`}`,
              id,
            );
            claim(meaning, "language", r`Declaring a function does not run it. Its body runs only when something calls ${c(name)}.`);
            const calls = otherUses.filter((occurrence) => occurrence.role === "call");
            whatIf.push({
              change: r`If you renamed ${c(name)}`,
              effect: otherUses.length > 0
                ? r`${capitalizeFirst(formatLineList(otherUses.map((occurrence) => occurrence.line)))} would break unless renamed too. Other files may use it as well.`
                : r`Any code that uses it by name would break. None found in this file; other files may use it.`,
              basis: "source",
              evidenceIds: [id],
            });
            if (calls.length > 0) {
              whatIf.push({
                change: r`If you added or removed an input`,
                effect: r`The calls on ${formatLineList(calls.map((occurrence) => occurrence.line))} would need to change to match.`,
                basis: "language",
                evidenceIds: [id],
              });
            }
          } else {
            define("Class", "A blueprint that groups data and the functions that work on it.");
            headline = r`${c(name)} = a ${declaration.kind} (a blueprint for objects)`;
            claim(meaning, "source", r`${c(name)} is a ${declaration.kind} ${onDeclaration ? "declared right here" : `declared on line ${declaration.line + 1} of this file`} (lines ${declaration.line + 1}–${declaration.endLine + 1}).`, id);
            const members = context.declarations.filter((candidate) => candidate.parent === context.declarations.indexOf(declaration));
            if (members.length > 0) {
              claim(fits, "source", r`It contains ${plural(members.length, "function")}: ${joinCode(members.slice(0, 6).map((member) => member.name))}${members.length > 6 ? " and more" : ""}.`, id);
            }
          }
          node("origin", `declared on line ${declaration.line + 1}`, declaration.headerText, "source", id);
          break;
        }
        case "assignment": {
          const assignment = origin.assignment;
          const id = addEvidence("source", assignmentLabel(assignment), assignment.statementRange);
          originEvidence = id;
          explainAssignment(assignment, id);
          if (origin.all.length > 1) {
            claim(fits, "source", r`This file gives ${c(name)} a value in ${origin.all.length} places (${formatLineList(origin.all.map((entry) => entry.line))}). Which one applies depends on the path the program takes.`);
            unknowns.push(r`Which of the ${origin.all.length} assignments to ${c(name)} is the one in effect when this line runs.`);
          }
          break;
        }
        case "builtin":
          kindLabel = "Built-in";
          headline = r`${c(name)} = built into ${profile.label}`;
          claim(meaning, "language", r`${c(name)} is not introduced anywhere in this file. ${origin.description}`, selectionId);
          node("origin", "provided by", `${profile.label} itself`, "language", undefined, false);
          break;
        default: {
          kindLabel = "Name";
          headline = r`${c(name)} comes from somewhere this file doesn't show`;
          claim(meaning, "source", r`This file does not show where ${c(name)} comes from: no import, assignment or declaration here introduces that name.`, selectionId);
          for (const wildcard of context.wildcardImports.slice(0, 2)) {
            const id = addEvidence("source", "Import that brings in unlisted names", wildcard.statementRange);
            claim(meaning, "name-match", r`It may come from line ${wildcard.line + 1} (${c(shorten(wildcard.statementText, 50))}), which brings in names without listing them. That is a possibility, not something Nexus has confirmed.`, id);
          }
          break;
        }
      }
      break;
    }
  }

  function explainAssignment(assignment: Assignment, id: string): void {
    const line = assignment.line + 1;
    const statement = c(shorten(assignment.statementText, 70));
    const laterUses = sameKind.filter((occurrence) => occurrence.role !== "introduction" && occurrence.line > assignment.line);
    define("Variable", "A name that holds a value so the program can use it later.");

    switch (assignment.form) {
      case "parameter": {
        const scope = assignment.scope === -1 ? undefined : context.declarations[assignment.scope];
        kindLabel = "Parameter (input)";
        headline = scope ? r`${c(name)} = an input to ${c(scope.name)}` : r`${c(name)} = a function input`;
        define("Parameter", "An input a function accepts. Its value is supplied by whoever calls the function.");
        claim(meaning, "source", r`${c(name)} is an input (a parameter) of ${scope ? r`the function ${c(scope.name)}` : "a function"}, declared on line ${line}. Its value is supplied by whoever calls ${scope ? c(scope.name) : "that function"}.`, id);
        node("origin", "input of function", scope?.name ?? assignment.statementText, "source", id);
        whatIf.push({
          change: r`If a caller passes a different value`,
          effect: r`${c(name)} holds that value inside the function.`,
          basis: "language",
          evidenceIds: [id],
        });
        unknowns.push(r`What value ${c(name)} actually receives. That depends on each call, at runtime.`);
        return;
      }
      case "loop-variable":
        kindLabel = "Loop variable";
        headline = r`${c(name)} = each item of ${short(assignment.valueText)}, one at a time`;
        claim(meaning, "source", r`${c(name)} is a loop variable. Line ${line} says ${statement}, so ${c(name)} holds one item of ${c(shorten(assignment.valueText, 40))} at a time while the loop runs.`, id);
        node("origin", "one item at a time from", assignment.valueText, "source", id);
        break;
      case "with-as":
        kindLabel = "Variable";
        headline = r`${c(name)} = what ${short(assignment.valueText)} sets up`;
        claim(meaning, "source", r`${c(name)} is the name line ${line} gives to what ${c(shorten(assignment.valueText, 40))} sets up, for use inside the ${c("with")} block.`, id);
        node("origin", "set up by", assignment.valueText, "source", id);
        break;
      case "except-as":
        kindLabel = "Caught error";
        headline = r`${c(name)} = the error that was caught`;
        claim(meaning, "source", r`${c(name)} holds the error caught on line ${line}.`, id);
        node("origin", "the error caught on", `line ${line}`, "source", id, false);
        break;
      default: {
        kindLabel = "Variable";
        if (assignment.siblingNames.length > 1 && assignment.unpack === "positional") {
          define("Unpacking", "Splitting a group of values into several names in one line.");
          headline = r`${c(name)} = the ${ordinal(assignment.indexAmongSiblings)} piece of ${short(assignment.valueText)}`;
          claim(meaning, "source", r`${c(name)} is one of ${assignment.siblingNames.length} names given a value together on line ${line}: ${statement}.`, id);
          claim(meaning, "language", r`With several names on the left, ${profile.label} splits the result of ${c(shorten(assignment.valueText, 40))} into pieces by position. ${c(name)} receives the ${ordinal(assignment.indexAmongSiblings)} piece.`);
          whatIf.push({
            change: r`If you swapped the order of ${joinCode(assignment.siblingNames)}`,
            effect: r`${c(name)} gets a different piece.`,
            basis: "language",
            evidenceIds: [id],
          });
        } else if (assignment.unpack === "by-name") {
          headline = r`${c(name)} = the ${c(name)} part of ${short(assignment.valueText)}`;
          claim(meaning, "source", r`${c(name)} is pulled out of ${c(shorten(assignment.valueText, 40))} by name on line ${line}: ${statement}. It receives the property called ${c(name)}.`, id);
        } else if (assignment.form === "update") {
          claim(meaning, "source", r`${c(name)} is a variable. Line ${line} updates it: ${statement}.`, id);
          headline = r`${c(name)} = a value that gets updated (line ${line})`;
        } else if (assignment.valueText) {
          claim(meaning, "source", r`${c(name)} is a variable. The closest place this file gives it a value is line ${line}: ${statement}.`, id);
          headline = r`${c(name)} = ${short(assignment.valueText, 44)}`;
        } else {
          claim(meaning, "source", r`${c(name)} is a variable declared on line ${line}: ${statement}.`, id);
          headline = r`${c(name)} = a variable (line ${line})`;
        }
        node("origin", `gets its value on line ${line}`, assignment.valueText || assignment.statementText, "source", id);
        break;
      }
    }

    if (assignment.valueText) {
      whatIf.push({
        change: r`If you changed ${c(shorten(assignment.valueText, 40))} on line ${line}`,
        effect: laterUses.length > 0
          ? r`${c(name)} holds a different value on ${formatLineList(laterUses.map((occurrence) => occurrence.line))}.`
          : r`${c(name)} holds a different value. (No later use found in this file.)`,
        basis: "source",
        evidenceIds: [id],
      });
    }
    unknowns.push(r`The actual value ${c(name)} holds while the program runs. Nexus reads the code; it does not run it.`);
  }

  // --- 2. provider definitions ------------------------------------------------
  const investigation = provider.investigation;
  const providerStatus: ProviderStatusLine[] = [];
  const confirmed = new Set<string>();
  let otherFileReferences = 0;
  const otherFiles = new Set<string>();

  if (investigation) {
    providerStatus.push(
      { label: "Definitions", status: investigation.definitionQuery.status, count: investigation.definitions.length, message: investigation.definitionQuery.message },
      { label: "References", status: investigation.referenceQuery.status, count: investigation.references.length, message: investigation.referenceQuery.message },
    );
    define("Language server", "A helper program that understands one programming language and answers questions such as “where is this defined?”.");

    investigation.definitions.slice(0, 3).forEach((definition) => {
      const sameFile = definition.uri === uri;
      const alreadyShown = sameFile && evidence.some((entry) => entry.basis === "source" && entry.id !== selectionId && entry.range.start.line <= definition.range.start.line && entry.range.end.line >= definition.range.start.line);
      const id = addEvidence("provider", "Definition (language server)", definition.range, definition.uri, definition.excerpt);
      if (alreadyShown) {
        claim(fits, "provider", r`The language server agrees: it reports the definition on line ${definition.range.start.line + 1}.`, id);
      } else {
        claim(meaning, "provider", r`The language server reports its definition in ${c(fileName(definition.uri))}, line ${definition.range.start.line + 1}.`, id);
        node("origin", "defined in (language server)", `${fileName(definition.uri)}:${definition.range.start.line + 1}`, "provider", id);
      }
    });
    if (isName && investigation.definitions.length === 0) {
      unknowns.push(r`Where ${c(name)} is ultimately defined. The language server returned no definition; that does not mean ${c(name)} is undefined.`);
    }

    for (const reference of investigation.references) {
      if (reference.uri === uri) {
        confirmed.add(`${reference.range.start.line}:${reference.range.start.character}`);
      } else {
        otherFileReferences += 1;
        otherFiles.add(reference.uri);
      }
    }
  } else {
    limits.push("No language server results were available, so this explanation uses only what is written in the open file.");
  }

  // --- 3. the whole expression ---------------------------------------------------
  const chain = analysis.chain;
  let calleeText: string | undefined;
  const onOwnDeclaration = origin.kind === "declaration" && origin.declaration.line === focus.line;
  const steps: Step[] = chain && chain.segments.length > 0 && !onOwnDeclaration ? chainSteps(context, chain) : [];
  if (chain && chain.segments.length > 0 && !onOwnDeclaration) {
    const described = describeChain(context, chain);
    calleeText = described.calleeText;
    claim(meaning, "language", described.text, selectionId);
    if (described.hasCall) {
      define("Call", "Running a function. Written as a name followed by parentheses.");
      define("Argument", "A value handed to a function when it is called, written between the parentheses.");
      unknowns.push(r`What ${c(described.calleeText)} actually does when it runs, and what it gives back. That is decided by its own code, which this line does not show.`);
      described.literalArguments.slice(0, 1).forEach((argument) => {
        whatIf.push({
          change: r`If you changed ${c(shorten(argument, 40))}`,
          effect: r`${c(described.calleeText)} gets the new value instead. What it does with it is up to ${c(described.calleeText)}.`,
          basis: "language",
          evidenceIds: [selectionId],
        });
      });
    }
  }

  // Result stored somewhere? (`left, right = st.columns(2)`)
  if (analysis.statement && chain) {
    const stored = context.assignments.filter(
      (assignment) => assignment.line >= analysis.statement!.startLine && assignment.line <= analysis.statement!.endLine && assignment.form !== "parameter" && assignment.name !== name && assignment.nameRange.start.character < context.lines.positionAt(context.tokens[chain.root].start).character,
    );
    if (stored.length > 0) {
      const id = addEvidence("source", "Where the result is stored", stored[0].statementRange);
      claim(fits, "source", r`The result of this expression is stored in ${joinCode(stored.map((assignment) => assignment.name))} on the same line.`, id);
      node("usage", "result stored in", stored.map((assignment) => assignment.name).join(", "), "source", id);
    }
  }

  // --- 4. documentation -------------------------------------------------------------
  const documentation = provider.documentation.filter((entry) => entry.text.trim().length > 0);
  for (const entry of documentation.slice(0, 2)) {
    const summary = firstProseLine(entry.text);
    if (summary) {
      claim(meaning, "provider", r`The language server's documentation describes ${c(entry.subject)} like this: “${summary}”`);
    }
  }
  if (documentation.length > 0) {
    unknowns.push(r`Whether the documentation above tells the whole story. It is a description supplied by the language server, not the implementation itself.`);
  }

  // --- 5. the statement around it -----------------------------------------------------
  const statement = analysis.statement;
  const enclosingIndex = enclosingDeclaration(context.declarations, focus.line);
  const enclosing = enclosingIndex === -1 ? undefined : context.declarations[enclosingIndex];
  if (statement) {
    const first = context.tokens[statement.first];
    if (first.kind === "keyword" && statement.first !== analysis.focusIndex && profile.keywords[first.text] && STATEMENT_KEYWORDS.has(first.text)) {
      const info = profile.keywords[first.text];
      claim(fits, "language", r`This line is a ${c(first.text)} statement. ${info.plain}`, addEvidence("source", "The statement it sits in", context.lines.rangeOf(first.start, context.tokens[statement.end - 1].end)));
      define(info.term, info.plain);
    }
  }
  const scope = enclosing && enclosing.line !== focus.line ? enclosing : enclosing && enclosing.parent !== -1 ? context.declarations[enclosing.parent] : undefined;
  if (scope) {
    const id = addEvidence("source", `Enclosing ${scope.kind}`, scope.nameRange);
    claim(fits, "source", r`It sits inside the ${scope.kind} ${c(scope.name)} (lines ${scope.line + 1}–${scope.endLine + 1}).`, id);
    node("origin", "lives inside", `${scope.kind} ${scope.name}`, "source", id, false);
  }

  // Argument position: `foo(a, |b|)`
  const bracket = context.enclosingBracket[analysis.focusIndex];
  if (bracket > 0 && context.tokens[bracket].text === "(" && context.tokens[bracket - 1].kind === "identifier" && context.tokens[bracket - 1].end === context.tokens[bracket].start && bracket - 1 !== analysis.focusIndex) {
    let position = 0;
    for (let index = bracket + 1; index < analysis.focusIndex; index += 1) {
      if (context.tokens[index].text === "," && context.enclosingBracket[index] === bracket) {
        position += 1;
      }
    }
    const isHeader = ["def", "function", "fn", "func"].includes(context.tokens[bracket - 2]?.text ?? "");
    if (!isHeader) {
      claim(fits, "source", r`It is the ${ordinal(position)} value handed to ${c(context.tokens[bracket - 1].text)} on this line.`, selectionId);
    }
  }

  // --- 6. where else it appears ----------------------------------------------------------
  if (isName) {
    define("Reference", "A place where a name is used. A reference is not proof that anything is called or run there.");
    const memberRoots = otherUses.filter((occurrence) => occurrence.role === "member-root" && occurrence.memberName);
    const calls = otherUses.filter((occurrence) => occurrence.role === "call");
    const plainUses = otherUses.filter((occurrence) => occurrence.role === "use");
    const occurrenceEvidence = (occurrence: Occurrence): string => {
      const isConfirmed = confirmed.has(`${occurrence.range.start.line}:${occurrence.range.start.character}`);
      return addEvidence(isConfirmed ? "provider" : "name-match", isConfirmed ? "Reference (language server)" : "Same name in this file", occurrence.range);
    };

    if (otherUses.length === 0) {
      claim(fits, "name-match", r`Nexus found no other place in this file that writes ${c(name)}${analysis.focusKind === "member" ? " after a dot" : ""}.`);
      node("usage", "other uses in this file", "none found", "name-match", undefined, false);
    } else {
      const confirmedCount = otherUses.filter((occurrence) => confirmed.has(`${occurrence.range.start.line}:${occurrence.range.start.character}`)).length;
      const ids = otherUses.slice(0, 12).map(occurrenceEvidence);
      claim(
        fits,
        confirmedCount === otherUses.length ? "provider" : "name-match",
        r`${c(name)} is written in ${plural(otherUses.length, "other place")} in this file (${formatLineList(otherUses.map((occurrence) => occurrence.line), 6)}). ${
          !investigation || investigation.references.length === 0
            ? "The language server gave no references, so Nexus can only say the spelling matches."
            : confirmedCount === otherUses.length
              ? "The language server links all of them to the same symbol."
              : `The language server links ${confirmedCount} of them to the same symbol; the rest only share the spelling.`
        }`,
        ...ids.slice(0, 6),
      );
      if (confirmedCount < otherUses.length) {
        unknowns.push(r`Whether every ${c(name)} in this file is the same thing. Matching spelling is not proof: two functions can each have their own ${c(name)}.`);
      }

      // Members reached through it: st -> .title(), .columns()
      const byMember = new Map<string, Occurrence[]>();
      memberRoots.forEach((occurrence) => {
        const list = byMember.get(occurrence.memberName!) ?? [];
        list.push(occurrence);
        byMember.set(occurrence.memberName!, list);
      });
      const members = [...byMember.entries()].sort((a, b) => b[1].length - a[1].length);
      if (members.length > 0) {
        claim(fits, "source", r`It is used to reach ${plural(members.length, "thing")} inside it: ${joinCode(members.slice(0, 8).map(([member, list]) => `.${member}${list[0].memberIsCalled ? "()" : ""}`))}${members.length > 8 ? " and more" : ""}.`, ...members.slice(0, 4).map(([, list]) => occurrenceEvidence(list[0])));
      }
      members.slice(0, 3).forEach(([member, list]) => {
        node("usage", list.length > 1 ? `used to reach (${list.length}×)` : `used to reach (line ${list[0].line + 1})`, `.${member}${list[0].memberIsCalled ? "()" : ""}`, "source", occurrenceEvidence(list[0]));
      });
      if (members.length > 3) {
        node("usage", "used to reach", `${members.length - 3} more members`, "source", undefined, false);
      }
      if (calls.length > 0) {
        claim(fits, "source", r`${plural(calls.length, "place")} write${calls.length === 1 ? "s" : ""} it as a call (${formatLineList(calls.map((occurrence) => occurrence.line))}). Call syntax shows it is written to be run there, not that the line is ever reached.`, ...calls.slice(0, 4).map(occurrenceEvidence));
        node("usage", "written as a call", formatLineList(calls.map((occurrence) => occurrence.line), 3), "source", occurrenceEvidence(calls[0]), false);
      }
      if (plainUses.length > 0) {
        node("usage", "also used on", formatLineList(plainUses.map((occurrence) => occurrence.line), 3), confirmed.has(`${plainUses[0].range.start.line}:${plainUses[0].range.start.character}`) ? "provider" : "name-match", occurrenceEvidence(plainUses[0]), false);
      }
    }

    const asMember = occurrences.filter((occurrence) => occurrence.role === "member");
    if (analysis.focusKind === "name" && asMember.length > 0) {
      claim(fits, "name-match", r`${plural(asMember.length, "other place")} write${asMember.length === 1 ? "s" : ""} ${c(`.${name}`)} after a dot (${formatLineList(asMember.map((occurrence) => occurrence.line))}). Those look inside something else and are probably a different thing.`);
    }

    if (otherFileReferences > 0 && investigation) {
      const sample = investigation.references.filter((reference) => reference.uri !== uri).slice(0, 4);
      const ids = sample.map((reference) => addEvidence("provider", "Reference in another file (language server)", reference.range, reference.uri, reference.excerpt));
      claim(project, "provider", r`The language server reports ${plural(otherFileReferences, "use")} in ${plural(otherFiles.size, "other file")}: ${joinCode([...otherFiles].slice(0, 4).map(fileName))}${otherFiles.size > 4 ? " and more" : ""}.`, ...ids);
      node("usage", "language server: also used in", plural(otherFiles.size, "other file"), "provider", ids[0], false);
    }
    if (investigation && investigation.references.length === 0) {
      unknowns.push(r`Whether ${c(name)} is used in other files. The language server returned no references; that does not prove there are none.`);
    }
    if (search.limited) {
      limits.push(`This file writes "${name}" ${search.total} times; Nexus looked at the first ${occurrences.length}.`);
    }
  }

  // --- 6b. the rest of the project ------------------------------------------------------------
  for (const definition of (provider.definitionContexts ?? []).slice(0, 2)) {
    const { summary } = definition;
    const id = addEvidence("provider", "Definition in another file", definition.range, definition.uri, summary.header);
    claim(
      project,
      "source",
      summary.name
        ? r`In ${c(fileName(definition.uri))}, line ${summary.line + 1} declares the ${summary.kind} ${c(summary.name)}: ${c(summary.header)}.${summary.parameters.length > 0 ? r` It takes ${plural(summary.parameters.length, "input")}: ${joinCode(summary.parameters.slice(0, 6))}.` : ""}`
        : r`In ${c(fileName(definition.uri))}, line ${summary.line + 1} reads: ${c(summary.header)}.`,
      id,
    );
    if (summary.authorNote) {
      claim(project, "source", r`Its author describes it like this: “${summary.authorNote}” This is the author's own note, not something Nexus verified.`, id);
    }
  }

  const importers = provider.importers ?? [];
  if (importers.length > 0) {
    const ids = importers.slice(0, 5).map((importer) =>
      addEvidence("name-match", "Import that names this file", { start: { line: importer.line, character: 0 }, end: { line: importer.line, character: 0 } }, importer.uri, importer.excerpt),
    );
    claim(project, "name-match", r`${plural(importers.length, "other file")} in this project ${importers.length === 1 ? "has" : "have"} an import that names this file: ${joinCode(importers.slice(0, 5).map((importer) => fileName(importer.uri)))}${importers.length > 5 ? " and more" : ""}. Nexus matched the import path by name; it has not confirmed how each import resolves.`, ...ids);
  }
  if (provider.importerScan?.limited) {
    limits.push(`Nexus checked ${provider.importerScan.filesScanned} project files for imports of this file and stopped there; larger projects may have more.`);
  }

  // --- 7. flow, limits, unknowns that always apply -----------------------------------------
  const flow = buildFlow(context, statement, enclosing);
  if (flow) {
    const block = flow.rows.find((row) => row.tone === "if");
    if (block && analysis.focusKind === "keyword" && ["if", "elif", "while"].includes(name)) {
      whatIf.push({
        change: r`If the condition were never true`,
        effect: r`The block it controls would never run.`,
        basis: "language",
        evidenceIds: [selectionId],
      });
    }
  }
  unknowns.push(r`Whether this line actually runs, and in what order compared with other lines. That depends on the path the program takes at runtime.`);

  if (context.partial) {
    limits.push(`This file is very large, so Nexus analysed only ${context.partial.map((window) => `lines ${window.startLine + 1}–${window.endLine + 1}`).join(" and ")}. Anything outside that range is not reflected here.`);
  }
  if (profile.support !== "detailed") {
    limits.push(describeSupport(profile));
  }

  // --- 8. assemble --------------------------------------------------------------------------
  const breakdown = buildBreakdown(context, analysis.expressionFirst, analysis.expressionEnd, analysis.focusIndex);
  node("focus", kindLabel, name, "source", selectionId);
  if (!mapNodes.some((entry) => entry.column === "origin")) {
    node("origin", "where it comes from", "not shown in this file", "name-match", undefined, false);
  }
  if (!mapNodes.some((entry) => entry.column === "usage")) {
    node("usage", "where it is used", isName ? "nothing else found" : "see the line itself", "name-match", undefined, false);
  }

  void originEvidence;
  void calleeText;

  return {
    hasContent: true,
    heading: shorten(analysis.expressionText, 120),
    headline: headline ?? r`${c(name)}`,
    steps,
    kindLabel,
    languageLabel: profile.label,
    supportLevel: profile.support,
    supportNote: describeSupport(profile),
    uri,
    range: focusRange,
    meaning,
    breakdown: breakdown.parts,
    breakdownTruncated: breakdown.truncated,
    fits,
    project,
    map: { nodes: capColumns(mapNodes) },
    flow,
    whatIf: whatIf.slice(0, 4),
    documentation: documentation.map((entry) => ({ subject: entry.subject, text: entry.text, truncated: entry.truncated })),
    unknowns,
    evidence,
    glossary: [...glossary.entries()].map(([term, plain]): GlossaryEntry => ({ term, plain })),
    limits,
    providerStatus,
  };
}

function emptyExplanation(languageLabel: string, supportNote: string, supportLevel: Explanation["supportLevel"], uri: string): Explanation {
  return {
    hasContent: false,
    emptyMessage: "Nexus did not find code at the cursor. It may be a blank line or a comment. Click on a name, keyword or expression and try again.",
    heading: "",
    headline: [],
    steps: [],
    kindLabel: "",
    languageLabel,
    supportLevel,
    supportNote,
    uri,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    meaning: [],
    breakdown: [],
    breakdownTruncated: false,
    fits: [],
    project: [],
    map: { nodes: [] },
    whatIf: [],
    documentation: [],
    unknowns: [],
    evidence: [],
    glossary: [],
    limits: [],
    providerStatus: [],
  };
}

function capColumns(nodes: readonly MapNode[]): MapNode[] {
  const result: MapNode[] = [];
  for (const column of ["origin", "focus", "usage"] as const) {
    const inColumn = nodes.filter((entry) => entry.column === column);
    result.push(...inColumn.slice(0, MAX_MAP_NODES_PER_COLUMN));
  }
  return result;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function joinCode(values: readonly string[]): Rich {
  const parts: (string | { code: string })[] = [];
  values.forEach((value, index) => {
    if (index > 0) {
      parts.push(index === values.length - 1 ? " and " : ", ");
    }
    parts.push(c(value));
  });
  return parts;
}

function fileName(uri: string): string {
  const path = uri.replace(/[?#].*$/, "");
  return decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)) || uri;
}

function assignmentLabel(assignment: Assignment): string {
  switch (assignment.form) {
    case "parameter":
      return "Function header (parameter)";
    case "loop-variable":
      return "Loop that sets it";
    case "with-as":
      return "With statement that sets it";
    case "except-as":
      return "Where the error is caught";
    default:
      return "Assignment";
  }
}

interface OriginDescription {
  readonly label: string;
  readonly range: SourceRange;
  readonly text: Rich;
  readonly caption: string;
  readonly nodeLabel: string;
}

/** A one-sentence description of where an owner name (the part before a dot) comes from. */
function describeOrigin(name: string, origin: NameOrigin): OriginDescription | undefined {
  switch (origin.kind) {
    case "declaration":
      return {
        label: `${capitalize(origin.declaration.kind)} declaration`,
        range: origin.declaration.nameRange,
        text: r`${c(name)} is a ${origin.declaration.kind} declared on line ${origin.declaration.line + 1} of this file.`,
        caption: `${name} declared on line ${origin.declaration.line + 1}`,
        nodeLabel: origin.declaration.headerText,
      };
    case "assignment":
      return {
        label: assignmentLabel(origin.assignment),
        range: origin.assignment.statementRange,
        text: origin.assignment.form === "parameter"
          ? r`${c(name)} is an input of the function declared on line ${origin.assignment.line + 1}.`
          : r`The closest place this file gives ${c(name)} a value is line ${origin.assignment.line + 1}: ${c(shorten(origin.assignment.statementText, 60))}.`,
        caption: `${name} set on line ${origin.assignment.line + 1}`,
        nodeLabel: origin.assignment.valueText || origin.assignment.statementText,
      };
    default:
      return undefined;
  }
}

interface ChainDescription {
  readonly text: Rich;
  readonly hasCall: boolean;
  readonly calleeText: string;
  readonly literalArguments: readonly string[];
}

/** "Read left to right: start at st, look inside it for title, then call that with the text ..." */
function describeChain(context: FileContext, chain: Chain): ChainDescription {
  const { tokens } = context;
  const steps: Rich[] = [r`start at ${c(tokens[chain.root].text)}`];
  const literalArguments: string[] = [];
  let hasCall = false;

  chain.segments.forEach((segment) => {
    if (segment.kind === "member") {
      steps.push(r`look inside it for ${c(tokens[segment.close].text)}`);
    } else if (segment.kind === "index") {
      steps.push(r`pick out the item at ${c(shorten(sourceText(context, segment.open + 1, segment.close), 30))}`);
    } else {
      hasCall = true;
      const args = splitArguments(context, segment.open, segment.close);
      if (args.length === 0) {
        steps.push(r`run it, handing it nothing`);
      } else {
        steps.push(r`run it, handing it ${describeArguments(context, args, literalArguments)}`);
      }
    }
  });

  const callee = calleeIndex(chain);
  const calleeText = callee === undefined ? tokens[chain.root].text : sourceText(context, chain.root, callee + 1);
  const text: (string | { code: string })[] = ["Read it left to right: "];
  steps.forEach((step, index) => {
    if (index > 0) {
      text.push(index === steps.length - 1 ? ", then " : ", ");
    }
    text.push(...step);
  });
  text.push(".");

  return { text, hasCall, calleeText, literalArguments };
}

function splitArguments(context: FileContext, open: number, close: number): [number, number][] {
  const args: [number, number][] = [];
  let start = open + 1;
  for (let index = open + 1; index <= close; index += 1) {
    const atEnd = index === close;
    if (atEnd || (context.tokens[index].text === "," && context.enclosingBracket[index] === open)) {
      if (index > start) {
        args.push([start, index]);
      }
      start = index + 1;
    }
  }
  return args;
}

function describeArguments(context: FileContext, args: readonly [number, number][], literals: string[]): Rich {
  const { tokens, profile } = context;
  const parts: (string | { code: string })[] = [];

  if (args.length > 3) {
    return r`${args.length} values: ${c(shorten(sourceText(context, args[0][0], args[args.length - 1][1]), 60))}`;
  }

  args.forEach(([first, end], index) => {
    if (index > 0) {
      parts.push(index === args.length - 1 ? " and " : ", ");
    }
    const text = sourceText(context, first, end);
    const single = end - first === 1 ? tokens[first] : undefined;

    if (single?.kind === "string") {
      literals.push(single.text);
      parts.push("the text ", c(shorten(single.text, 50)));
    } else if (single?.kind === "number") {
      literals.push(single.text);
      parts.push("the number ", c(single.text));
    } else if (single?.kind === "identifier") {
      parts.push("the value of ", c(single.text));
    } else if (profile.family === "python" && tokens[first].kind === "identifier" && tokens[first + 1]?.text === "=") {
      parts.push("the option ", c(tokens[first].text), " set to ", c(shorten(sourceText(context, first + 2, end), 40)));
    } else {
      parts.push("the result of ", c(shorten(text, 50)));
    }
  });

  return parts;
}

function capitalizeFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function firstSentence(text: string): string {
  const match = /^[^.!?]*[.!?]/.exec(text);
  return (match ? match[0] : text).replace(/\.$/, "").replace(/^./, (character) => character.toLowerCase());
}

/** Left-to-right boxes for an expression: st → look inside: title → run with: "text". */
function chainSteps(context: FileContext, chain: Chain): Step[] {
  const { tokens } = context;
  const steps: Step[] = [{ verb: "start with", code: tokens[chain.root].text }];
  for (const segment of chain.segments.slice(0, 6)) {
    if (segment.kind === "member") {
      steps.push({ verb: "look inside for", code: tokens[segment.close].text });
    } else if (segment.kind === "index") {
      steps.push({ verb: "pick item", code: `[${shorten(sourceText(context, segment.open + 1, segment.close), 24)}]` });
    } else {
      const inside = sourceText(context, segment.open + 1, segment.close);
      steps.push({ verb: inside ? "run it with" : "run it", code: inside ? shorten(inside, 40) : "()" });
    }
  }
  return steps;
}

/** Picks the first line of provider documentation that reads like a sentence rather than a signature. */
function firstProseLine(text: string): string | undefined {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    const words = line.split(/\s+/).length;
    const looksLikeCode = /^[([`]|^(def|class|function|const|let|var|import|module|fn|func)\b|=>|->|^\w+\(.*\)/.test(line) || /[{};]$/.test(line);
    if (!looksLikeCode && words >= 4 && /[a-zA-Z]{3}/.test(line)) {
      return shorten(line, 220);
    }
  }
  return undefined;
}
