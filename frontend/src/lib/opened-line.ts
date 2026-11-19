/**
 * The line a drop opened in the editor (7), still empty: the note it is in, and the body as the
 * editor reports it with that line and nothing on it. A drop let go and left without a word must
 * leave the file and its revision as they were: an empty paragraph would be written as `<br />`
 * and synced everywhere. Kept apart from `open-line.ts`, which pulls the editor in, so the list's
 * chunk can read it.
 */
export interface OpenedLine {
  id: string;
  empty: string;
}

/**
 * What a body the editor reports means for a line a drop opened. While it is the body with the
 * line still empty, it is not an edit: `skip` the save and keep holding the line. Anything else,
 * the first word or another note's body, is an ordinary edit, and the line is let go.
 */
export function settleOpenedLine(
  line: OpenedLine | undefined,
  id: string | undefined,
  markdown: string,
): { skip: boolean; line: OpenedLine | undefined } {
  if (line !== undefined && line.id === id && line.empty === markdown) {
    return { skip: true, line };
  }
  return { skip: false, line: undefined };
}
