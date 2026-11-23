import { splitTitle } from "./note-title";

/**
 * Turns the unified diff between a version and the draft into per-line marks on the body.
 *
 * Opening the history never replaces the body with a diff frame. It raises "added" and
 * "removed" marks in the margin of the draft body itself. A removed line exists only in the
 * selected version, so one document (the merged body) is built with those lines inserted at
 * their place in the draft, and the marks are attached to those lines. MarkdownPreview draws
 * it, and each mark becomes a class on a block (lineMarksPlugin in `lib/markdown.ts`).
 */

export type LineMark = "add" | "del";

export interface MarkedBody {
  /** The draft with the removed lines inserted back at their original positions. */
  source: string;
  /** The mark for each line of `source`. An unchanged line is undefined. */
  marks: readonly (LineMark | undefined)[];
}

const HUNK = /^@@ -(?<oldStart>\d+)(?:,(?<oldLen>\d+))? \+(?<newStart>\d+)(?:,(?<newLen>\d+))? @@/u;

/** Splits into lines. A trailing newline ends the last line; it is not an empty line. */
function linesOf(text: string): string[] {
  if (text === "") {
    return [];
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Draft + diff gives the merged body and the per-line marks. An empty diff (identical
 * content) returns the draft as it is, with no marks.
 *
 * A hunk's `+c,d` is a 1-based line number on the draft side. When `d` is 0 (a hunk that
 * only removes), `c` points at the position after that line.
 */
export function markLines(draft: string, diff: string): MarkedBody {
  const source = linesOf(draft);
  const out: string[] = [];
  const marks: (LineMark | undefined)[] = [];
  let cursor = 0;
  const take = (upTo: number): void => {
    while (cursor < upTo && cursor < source.length) {
      out.push(source[cursor] ?? "");
      marks.push(undefined);
      cursor += 1;
    }
  };

  /** Before the first hunk come the `+++` / `---` headers. They are not body lines. */
  let inHunk = false;

  for (const line of linesOf(diff)) {
    const hunk = HUNK.exec(line);
    if (hunk?.groups) {
      const start = Number(hunk.groups.newStart);
      const length = hunk.groups.newLen === undefined ? 1 : Number(hunk.groups.newLen);
      take(length === 0 ? start : start - 1);
      inHunk = true;
    }
    // Inside a hunk, `+---` (an added rule) is a body line too. What tells it from a
    // header is the position, not the spelling
    switch (hunk || !inHunk ? "@" : line[0]) {
      case " ": {
        out.push(line.slice(1));
        marks.push(undefined);
        cursor += 1;
        break;
      }
      case "+": {
        out.push(line.slice(1));
        marks.push("add");
        cursor += 1;
        break;
      }
      case "-": {
        out.push(line.slice(1));
        marks.push("del");
        break;
      }
      default: {
        // `\ No newline at end of file` is not a line
        break;
      }
    }
  }
  take(source.length);
  return { source: out.join("\n"), marks };
}

/**
 * The form put on screen. The leading H1 belongs to the title field, so it is dropped from
 * the merged body too, by the same rule as `splitTitle`. If the title changed, the old title
 * (a removed line) comes first and is the one dropped, and the new title stays in the body as
 * an H1 carrying `+`, so the title change is still readable.
 */
export function markedBody(draft: string, diff: string): MarkedBody {
  const marked = markLines(draft, diff);
  const lines = marked.source.split("\n");
  const { title } = splitTitle(marked.source);
  if (title === "" && !/^#[ \t]+/u.test(lines[0] ?? "")) {
    return marked;
  }
  let dropped = 1;
  if (lines[1] === "") {
    dropped = 2;
  }
  return {
    source: lines.slice(dropped).join("\n"),
    marks: marked.marks.slice(dropped),
  };
}

/** The number of lines that moved between the selected version and the draft. */
export interface LineCounts {
  added: number;
  removed: number;
}

/**
 * The numbers behind "3 lines added, 1 line removed". They are counted from the diff the
 * compare mode has already read, so producing them adds no IPC call at all.
 *
 * The `---` / `+++` headers are not lines, but `+---` inside a hunk (an added rule) is. What
 * tells them apart is the position, not the spelling: the same rule as [`markLines`].
 */
export function diffLineCounts(diff: string): LineCounts {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of linesOf(diff)) {
    if (HUNK.test(line)) {
      inHunk = true;
    } else if (inHunk && line.startsWith("+")) {
      added += 1;
    } else if (inHunk && line.startsWith("-")) {
      removed += 1;
    }
  }
  return { added, removed };
}

/**
 * The mark for one block. `del` if every line in the range is removed, `add` (changed) if the
 * range holds at least one added or removed line, and no mark if it holds neither.
 */
export function blockMark(
  marks: readonly (LineMark | undefined)[],
  from: number,
  to: number,
): LineMark | undefined {
  if (to <= from) {
    return undefined;
  }
  let touched = false;
  let allDeleted = true;
  for (let line = from; line < to; line += 1) {
    const mark = marks[line];
    if (mark !== undefined) {
      touched = true;
    }
    if (mark !== "del") {
      allDeleted = false;
    }
  }
  if (!touched) {
    return undefined;
  }
  return allDeleted ? "del" : "add";
}
