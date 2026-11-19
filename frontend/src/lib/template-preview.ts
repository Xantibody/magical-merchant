/**
 * The few Markdown shapes the template preview draws.
 *
 * The preview redraws on every keystroke, so it is not MarkdownPreview: that renders
 * the whole document into innerHTML each time, and pulls markdown-it into this chunk.
 * A template is a skeleton of headings, checklists and prompts; a line-by-line reading
 * of those is enough to show "this is what it makes", and each line stays its own node.
 */

export type PreviewBlock =
  | { kind: "heading"; level: 1 | 2; text: string }
  | { kind: "task"; done: boolean; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "paragraph"; text: string };

const HEADING = /^(?<marks>#{1,6})\s+(?<text>.*)$/u;
const TASK = /^[-*+]\s+\[(?<mark>[ xX])\]\s?(?<text>.*)$/u;
const BULLET = /^[-*+]\s+(?<text>.*)$/u;

function readLine(line: string): PreviewBlock {
  const heading = HEADING.exec(line)?.groups;
  if (heading) {
    return {
      kind: "heading",
      level: heading.marks.length === 1 ? 1 : 2,
      text: heading.text.trim(),
    };
  }
  const task = TASK.exec(line)?.groups;
  if (task) {
    return { kind: "task", done: task.mark !== " ", text: task.text.trim() };
  }
  const bullet = BULLET.exec(line)?.groups;
  if (bullet) {
    return { kind: "bullet", text: bullet.text.trim() };
  }
  return { kind: "paragraph", text: line.trim() };
}

/** One block per non-blank line. Blank lines only separate, and the layout spaces blocks. */
export function previewBlocks(text: string): PreviewBlock[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => readLine(line.trimEnd()));
}
