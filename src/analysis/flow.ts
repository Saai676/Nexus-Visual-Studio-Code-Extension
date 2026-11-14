/**
 * If/then flow: describes how a control statement steers execution.
 *
 * These rows state GENERAL language rules ("the block runs only when
 * the condition is true") applied to the line ranges visible in the
 * file. They never claim that a branch actually ran.
 */
import { c, r, type Flow, type FlowRow, type Rich } from "./explanationModel";
import type { Declaration, FileContext, Statement } from "./fileContext";
import { blockOf, followingBranch, sourceText, type Block } from "./selection";
import { shorten } from "./text";

function lineSpan(block: Block | undefined): string {
  if (!block) {
    return "the code that follows";
  }
  return block.startLine === block.endLine
    ? `line ${block.startLine + 1}`
    : `lines ${block.startLine + 1}–${block.endLine + 1}`;
}

/** Tokens between a keyword and the start of its block, with wrapping brackets removed. */
function headerText(context: FileContext, statement: Statement, keywordIndex: number): string {
  const { tokens, profile } = context;
  let first = keywordIndex + 1;
  let end = statement.end;
  const level = context.enclosingBracket[statement.first];

  for (let index = first; index < statement.end; index += 1) {
    const text = tokens[index].text;
    if (context.enclosingBracket[index] !== level) {
      continue;
    }
    if ((profile.blockStyle === "indent" && text === ":") || (profile.blockStyle === "braces" && text === "{")) {
      end = index;
      if (profile.blockStyle === "braces") {
        break;
      }
    }
  }

  if (tokens[first]?.text === "(" && context.matchingBracket.get(first) === end - 1) {
    first += 1;
    end -= 1;
  }

  return shorten(sourceText(context, first, end), 60);
}

export function buildFlow(
  context: FileContext,
  statement: Statement | undefined,
  enclosingFunction: Declaration | undefined,
): Flow | undefined {
  if (!statement || context.profile.support === "generic") {
    return undefined;
  }

  const { tokens } = context;
  let keywordIndex = statement.first;
  // `} else if (...) {` and `async def` / `async function`
  while (keywordIndex < statement.end - 1 && ["}", "async", "export", "public", "private", "protected", "static", "pub"].includes(tokens[keywordIndex].text)) {
    keywordIndex += 1;
  }
  const keyword = tokens[keywordIndex];
  if (!keyword || keyword.kind !== "keyword") {
    return undefined;
  }

  const block = blockOf(context, statement);
  const body = lineSpan(block);
  const rows: FlowRow[] = [];
  const row = (tag: string, tone: FlowRow["tone"], text: Rich): void => {
    rows.push({ tag, tone, text });
  };
  let word = keyword.text;
  if (word === "else" && tokens[keywordIndex + 1]?.text === "if") {
    word = "elif";
    keywordIndex += 1;
  }

  switch (word) {
    case "if":
    case "elif": {
      const condition = headerText(context, statement, keywordIndex);
      if (word === "elif") {
        row("ONLY IF", "note", r`the conditions above this one were all false`);
      }
      row("IF", "if", r`${c(condition)} is true`);
      row("THEN", "then", r`${body} run${block && block.startLine !== block.endLine ? "" : "s"}`);
      const branch = followingBranch(context, statement, ["elif", "else"]);
      if (branch) {
        const branchBlock = blockOf(context, branch);
        const isElse = sourceText(context, branch.first, branch.end).replace(/^}\s*/, "").startsWith("else") && !/^}?\s*else\s+if/.test(sourceText(context, branch.first, branch.end));
        row(
          "OTHERWISE",
          "else",
          isElse
            ? r`${lineSpan(branchBlock)} run${branchBlock && branchBlock.startLine !== branchBlock.endLine ? "" : "s"} instead`
            : r`the next condition on line ${branch.startLine + 1} is checked`,
        );
      } else {
        row("OTHERWISE", "else", r`that block is skipped and the program carries on after it`);
      }
      return { title: "Which way the code goes", shape: "decision", rows };
    }
    case "else":
      row("IF", "if", r`none of the conditions above were true`);
      row("THEN", "then", r`${body} run${block && block.startLine !== block.endLine ? "" : "s"}`);
      return { title: "Which way the code goes", shape: "steps", rows };
    case "for":
    case "foreach": {
      const header = headerText(context, statement, keywordIndex);
      row("FOR EACH", "if", r`${c(header)}`);
      row("DO", "then", r`${body}, once per round`);
      row("WHEN DONE", "else", r`the program carries on after the block`);
      row("NOTE", "note", r`if there is nothing to loop over, the block does not run at all`);
      return { title: "How the loop repeats", shape: "loop", rows };
    }
    case "while": {
      const condition = headerText(context, statement, keywordIndex);
      row("WHILE", "if", r`${c(condition)} is true`);
      row("REPEAT", "then", r`${body}, then check the condition again`);
      row("WHEN FALSE", "else", r`the loop stops and the program carries on after it`);
      return { title: "How the loop repeats", shape: "loop", rows };
    }
    case "with": {
      const header = headerText(context, statement, keywordIndex);
      row("FIRST", "if", r`set up ${c(header)}`);
      row("THEN", "then", r`${body} run${block && block.startLine !== block.endLine ? "" : "s"} using it`);
      row("FINALLY", "else", r`clean up automatically when the block ends, even if an error happened inside`);
      return { title: "How the with-block works", shape: "steps", rows };
    }
    case "try": {
      row("TRY", "if", r`${body}`);
      const handler = followingBranch(context, statement, ["except", "catch"]);
      if (handler) {
        const handlerBlock = blockOf(context, handler);
        row("IF IT FAILS", "else", r`jump to line ${handler.startLine + 1} and run ${lineSpan(handlerBlock)}`);
      } else {
        row("IF IT FAILS", "else", r`the error is passed on to whatever handles it`);
      }
      row("IF IT WORKS", "then", r`the error-handling block is skipped`);
      return { title: "What happens if it fails", shape: "decision", rows };
    }
    case "except":
    case "catch": {
      const header = headerText(context, statement, keywordIndex);
      row("IF", "if", header ? r`the ${c("try")} block above fails with ${c(header)}` : r`the ${c("try")} block above fails`);
      row("THEN", "then", r`${body} run${block && block.startLine !== block.endLine ? "" : "s"}`);
      row("OTHERWISE", "else", r`this block is skipped`);
      return { title: "What happens if it fails", shape: "decision", rows };
    }
    case "def":
    case "function":
    case "fn":
    case "func": {
      row("WHEN", "if", r`something calls this function`);
      row("THEN", "then", r`${body} run${block && block.startLine !== block.endLine ? "" : "s"} with the inputs that were passed in`);
      row("NOTE", "note", r`reading this line only creates the function; the body does not run until it is called`);
      return { title: "When this function runs", shape: "steps", rows };
    }
    case "return": {
      const value = shorten(sourceText(context, keywordIndex + 1, statement.end).replace(/;$/, ""), 60);
      row("WHEN", "if", r`the program reaches this line`);
      row(
        "THEN",
        "then",
        enclosingFunction
          ? r`${c(enclosingFunction.name)} stops here${value ? r` and hands back ${c(value)}` : ""}`
          : r`the function stops here${value ? r` and hands back ${c(value)}` : ""}`,
      );
      row("NOTE", "note", r`any lines after it in the same block are not run`);
      return { title: "What return does here", shape: "steps", rows };
    }
    default:
      return undefined;
  }
}
