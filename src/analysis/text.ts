/**
 * Small text helpers shared by the analysis modules.
 *
 * Nothing in src/analysis imports the VS Code API. That keeps the
 * analysis deterministic and lets it run under plain Node in tests.
 */
import type { SourcePosition, SourceRange } from "../investigationModel";

/** Converts between character offsets and line/character positions. */
export class LineIndex {
  private readonly lineStarts: number[] = [0];

  constructor(readonly text: string) {
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) === 10) {
        this.lineStarts.push(index + 1);
      }
    }
  }

  get lineCount(): number {
    return this.lineStarts.length;
  }

  positionAt(offset: number): SourcePosition {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    let low = 0;
    let high = this.lineStarts.length - 1;

    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.lineStarts[middle] <= clamped) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }

    return { line: low, character: clamped - this.lineStarts[low] };
  }

  offsetAt(position: SourcePosition): number {
    const line = Math.max(0, Math.min(position.line, this.lineStarts.length - 1));
    const lineStart = this.lineStarts[line];
    const lineEnd = this.lineEndOffset(line);

    return Math.max(lineStart, Math.min(lineStart + position.character, lineEnd));
  }

  rangeOf(startOffset: number, endOffset: number): SourceRange {
    return {
      start: this.positionAt(startOffset),
      end: this.positionAt(endOffset),
    };
  }

  lineStartOffset(line: number): number {
    return this.lineStarts[Math.max(0, Math.min(line, this.lineStarts.length - 1))];
  }

  /** Offset just past the last visible character of the line. */
  lineEndOffset(line: number): number {
    const next =
      line + 1 < this.lineStarts.length
        ? this.lineStarts[line + 1] - 1
        : this.text.length;

    return next > 0 && this.text.charCodeAt(next - 1) === 13 ? next - 1 : next;
  }

  lineText(line: number): string {
    if (line < 0 || line >= this.lineStarts.length) {
      return "";
    }

    return this.text.slice(this.lineStartOffset(line), this.lineEndOffset(line));
  }
}

/** Shortens text for display without cutting through the middle of a word when possible. */
export function shorten(value: string, maxLength: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

/** "line 4" / "lines 4, 9 and 12" / "lines 4, 9, 12 and 3 more". */
export function formatLineList(lines: readonly number[], maxShown = 4): string {
  const unique = [...new Set(lines)].sort((a, b) => a - b);
  if (unique.length === 0) {
    return "no lines";
  }

  const humanLines = unique.map((line) => line + 1);
  if (humanLines.length === 1) {
    return `line ${humanLines[0]}`;
  }

  if (humanLines.length <= maxShown) {
    return `lines ${humanLines.slice(0, -1).join(", ")} and ${humanLines[humanLines.length - 1]}`;
  }

  return `lines ${humanLines.slice(0, maxShown).join(", ")} and ${humanLines.length - maxShown} more`;
}

export function ordinal(index: number): string {
  const words = ["first", "second", "third", "fourth", "fifth", "sixth"];
  return words[index] ?? `${index + 1}th`;
}
