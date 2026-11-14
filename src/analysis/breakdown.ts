/**
 * Syntax breakdown: splits the selected expression into pieces and
 * gives each piece a short label a beginner can read.
 *
 * Labels for names use what the file shows (an import, an assignment,
 * a declaration). Labels for punctuation and keywords use general
 * language rules.
 */
import { c, r, type BreakdownPart, type PartRole, type Rich } from "./explanationModel";
import type { FileContext } from "./fileContext";
import { resolveName } from "./selection";
import { shorten } from "./text";
import { stringContent } from "./tokenizer";

const MAX_PARTS = 36;

interface OperatorNote {
  readonly label: string;
  readonly detail: string;
}

const OPERATOR_NOTES: Readonly<Record<string, OperatorNote>> = {
  "=": { label: "store", detail: "Stores the value on the right under the name on the left." },
  ":=": { label: "create + store", detail: "Creates the name on the left and stores the value on the right in it." },
  "==": { label: "equal?", detail: "Asks whether the two sides are equal. The answer is true or false." },
  "===": { label: "equal?", detail: "Asks whether the two sides are equal and of the same type." },
  "!=": { label: "different?", detail: "Asks whether the two sides are different." },
  "!==": { label: "different?", detail: "Asks whether the two sides are different in value or type." },
  "<": { label: "less than?", detail: "Asks whether the left side is smaller than the right side." },
  ">": { label: "greater than?", detail: "Asks whether the left side is bigger than the right side." },
  "<=": { label: "at most?", detail: "Asks whether the left side is smaller than or equal to the right side." },
  ">=": { label: "at least?", detail: "Asks whether the left side is bigger than or equal to the right side." },
  "+": { label: "add / join", detail: "Adds numbers, or joins pieces of text together." },
  "-": { label: "subtract", detail: "Subtracts the right side from the left side." },
  "*": { label: "multiply", detail: "Multiplies the two sides. In some positions it means “all of these”." },
  "/": { label: "divide", detail: "Divides the left side by the right side." },
  "%": { label: "remainder", detail: "Gives what is left over after dividing." },
  "**": { label: "power", detail: "Raises the left side to the power of the right side." },
  "+=": { label: "add + store", detail: "Adds the right side to the name on the left and stores the result back in it." },
  "-=": { label: "subtract + store", detail: "Subtracts the right side from the name on the left and stores the result back." },
  "*=": { label: "multiply + store", detail: "Multiplies the name on the left by the right side and stores the result back." },
  "/=": { label: "divide + store", detail: "Divides the name on the left by the right side and stores the result back." },
  "&&": { label: "and", detail: "True only when both sides are true." },
  "||": { label: "or", detail: "True when at least one side is true." },
  "!": { label: "not", detail: "Flips true to false and false to true." },
  "??": { label: "or else", detail: "Uses the right side when the left side is missing." },
  "=>": { label: "arrow function", detail: "Creates a small function: inputs on the left, what it produces on the right." },
  "->": { label: "gives back", detail: "States the type of value a function gives back, or reaches inside through a pointer." },
  "...": { label: "spread", detail: "Unpacks a collection into its individual items." },
  "@": { label: "decorator", detail: "Wraps the function or class below with extra behaviour." },
  "#": { label: "preprocessor", detail: "Starts an instruction that is handled before the code is compiled." },
  "&": { label: "address / and", detail: "Refers to where a value lives, or combines bits." },
  "?": { label: "choose", detail: "Picks between two values depending on a condition." },
  "++": { label: "add 1", detail: "Increases the number by one." },
  "--": { label: "subtract 1", detail: "Decreases the number by one." },
  "<-": { label: "send / receive", detail: "Sends a value into a channel or receives one from it." },
};

const ACCESS_NOTES: Readonly<Record<string, OperatorNote>> = {
  ".": { label: "look inside", detail: "The dot means “look inside the thing on the left for the name on the right”." },
  "?.": { label: "look inside, if any", detail: "Looks inside the thing on the left, but only if it exists." },
  "::": { label: "look inside", detail: "The double colon means “look inside the module or type on the left”." },
  "->": { label: "look inside", detail: "The arrow looks inside the thing a pointer points at." },
};

export interface BreakdownResult {
  readonly parts: BreakdownPart[];
  readonly truncated: boolean;
}

export function buildBreakdown(
  context: FileContext,
  first: number,
  end: number,
  focusIndex: number,
): BreakdownResult {
  const { tokens, profile } = context;
  const parts: BreakdownPart[] = [];
  const limit = Math.min(end, first + MAX_PARTS);

  for (let index = first; index < limit; index += 1) {
    const token = tokens[index];
    const previous = index > 0 ? tokens[index - 1] : undefined;
    const next = tokens[index + 1];
    const focus = index === focusIndex;
    const afterMember = previous !== undefined && profile.memberOperators.includes(previous.text) && previous.line === token.line;

    const push = (role: PartRole, label: string, detail?: Rich): void => {
      parts.push({ text: shorten(token.text, 48), role, label, detail, focus });
    };

    if (token.kind === "string") {
      const prefix = /^[A-Za-z@$]+/.exec(token.text)?.[0] ?? "";
      const formatted = /f/i.test(prefix) || token.text.startsWith("`") || prefix.includes("$");
      push(
        "text",
        formatted ? "text with blanks" : "text",
        formatted
          ? r`Text (a string) with placeholders that are filled in with values when the code runs.`
          : r`A piece of text, called a string. The program uses these characters exactly as written: ${c(shorten(stringContent(token.text), 40))}.`,
      );
      continue;
    }

    if (token.kind === "number") {
      push("number", "number", r`A number written directly in the code.`);
      continue;
    }

    if (token.kind === "keyword") {
      const info = profile.keywords[token.text];
      push("keyword", shortTerm(info.term), r`${c(token.text)}: ${info.plain}`);
      continue;
    }

    if (token.kind === "identifier") {
      if (afterMember) {
        const owner = tokens[index - 2];
        const called = next?.text === "(";
        push(
          "member",
          called ? "thing to run" : "thing inside",
          owner
            ? r`${c(token.text)} is looked up inside ${c(shorten(owner.text, 24))}.${called ? " The parentheses after it mean it is called." : ""}`
            : r`${c(token.text)} is looked up inside the thing before the dot.`,
        );
        continue;
      }

      const bracket = context.enclosingBracket[index];
      const inHeader = bracket >= 2 && ["def", "function", "fn", "func"].includes(tokens[bracket - 2]?.text ?? "");
      if (inHeader && tokens[bracket].text === "(" && previous !== undefined && (previous.text === "(" || previous.text === ",")) {
        push("name", "input", r`${c(token.text)} is an input (parameter) this function accepts.`);
        continue;
      }
      if (
        profile.family === "python" &&
        next?.text === "=" &&
        bracket >= first &&
        tokens[bracket]?.text === "(" &&
        previous !== undefined &&
        (previous.text === "(" || previous.text === ",")
      ) {
        push("plain", "option name", r`${c(token.text)} names which option the value after ${c("=")} is for.`);
        continue;
      }

      const described = describeName(context, token.text, token.line, next?.text === "(");
      push("name", described.label, described.detail);
      continue;
    }

    if (profile.memberOperators.includes(token.text) && next && (next.kind === "identifier" || next.kind === "keyword") && previous && previous.kind !== "operator") {
      const note = ACCESS_NOTES[token.text] ?? ACCESS_NOTES["."];
      push("access", note.label, r`${note.detail}`);
      continue;
    }

    if (token.text === "(") {
      const isCall = previous !== undefined && previous.end === token.start && (previous.kind === "identifier" || previous.text === ")" || previous.text === "]");
      const isHeader = previous !== undefined && index >= 2 && ["def", "function", "fn", "func"].includes(tokens[index - 2]?.text ?? "");
      if (isHeader) {
        push("call", "inputs", r`In a function header, the parentheses list the inputs (parameters) the function accepts.`);
      } else if (isCall) {
        push("call", "run it with…", r`Parentheses right after a name mean “run this”. Whatever is between them is handed over as input.`);
      } else {
        push("plain", "", undefined);
      }
      continue;
    }

    if (token.text === "[") {
      const isIndex = previous !== undefined && previous.end === token.start && (previous.kind === "identifier" || previous.text === ")" || previous.text === "]");
      push(
        "call",
        isIndex ? "pick an item" : "list",
        isIndex
          ? r`Square brackets right after a name pick one item out of it, by position or by key.`
          : r`Square brackets on their own write out a list of items.`,
      );
      continue;
    }

    if (token.text === ":" && profile.family === "python" && index === end - 1) {
      push("plain", "block starts", r`A colon at the end of a line means the indented lines below belong to this statement.`);
      continue;
    }

    if (token.text === "{" && profile.blockStyle === "braces" && index === end - 1) {
      push("plain", "block starts", r`An opening brace starts the block of code that belongs to this statement.`);
      continue;
    }

    const headerBracket = context.enclosingBracket[index];
    if (token.text === "=" && headerBracket >= 2 && ["def", "function", "fn", "func"].includes(tokens[headerBracket - 2]?.text ?? "")) {
      push("operator", "default", r`In a function header, ${c("=")} gives an input a default value, used when the caller does not supply one.`);
      continue;
    }

    const note = token.kind === "operator" ? OPERATOR_NOTES[token.text] : undefined;
    if (note) {
      push("operator", note.label, r`${c(token.text)}: ${note.detail}`);
      continue;
    }

    push("plain", "", undefined);
  }

  return { parts, truncated: end > limit };
}

function shortTerm(term: string): string {
  return term.replace(/\s*\(.*\)$/, "");
}

function describeName(
  context: FileContext,
  name: string,
  line: number,
  called: boolean,
): { label: string; detail: Rich } {
  const origin = resolveName(context, name, line);
  const callNote = called ? " Here it is called." : "";

  switch (origin.kind) {
    case "import": {
      const binding = origin.binding;
      if (binding.isAlias) {
        return {
          label: `short for ${shorten(binding.importedName, 18)}`,
          detail: r`${c(name)} is this file's short name for ${c(binding.importedName)} (line ${binding.line + 1}).${callNote}`,
        };
      }
      return {
        label: binding.form === "module" || binding.form === "namespace" ? "imported module" : "imported",
        detail: r`${c(name)} is imported from ${c(binding.module)} on line ${binding.line + 1}.${callNote}`,
      };
    }
    case "declaration": {
      const kind = origin.declaration.kind;
      return {
        label: kind,
        detail: r`${c(name)} is a ${kind} declared on line ${origin.declaration.line + 1} of this file.${callNote}`,
      };
    }
    case "assignment": {
      const assignment = origin.assignment;
      const labels: Readonly<Record<string, string>> = {
        parameter: "input",
        "loop-variable": "loop variable",
        "with-as": "variable",
        "except-as": "caught error",
        update: "variable",
        declaration: "variable",
        assignment: "variable",
      };
      const detail =
        assignment.form === "parameter"
          ? r`${c(name)} is an input (parameter) of the function declared on line ${assignment.line + 1}.${callNote}`
          : r`${c(name)} is a name this file gives a value to on line ${assignment.line + 1}.${callNote}`;
      return { label: labels[assignment.form] ?? "variable", detail };
    }
    case "builtin":
      return { label: "built-in", detail: r`${c(name)}: ${origin.description}${callNote}` };
    default:
      return {
        label: called ? "thing to run" : "name",
        detail: r`${c(name)} is a name. This file does not show where it is introduced.${callNote}`,
      };
  }
}
