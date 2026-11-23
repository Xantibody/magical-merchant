import type { MarkdownIt, Token } from "markdown-it";

/** The GFM task list marker. It needs a trailing space, the same as remark (the editor). */
const TASK_MARKER = /^\[(?<mark>[ xX])\] /u;

/** Whether token i is the inline of the first paragraph under an li. A marker only sits there. */
function opensListItem(tokens: Token[], i: number): boolean {
  return (
    tokens[i].type === "inline" &&
    tokens[i - 1].type === "paragraph_open" &&
    tokens[i - 2].type === "list_item_open"
  );
}

/**
 * A markdown-it plugin that turns `- [ ]` / `- [x]` into a task li.
 *
 * markdown-it does not know GFM task lists and emits `[ ]` as plain text. The editor
 * (Milkdown's gfm) folds the same line into the li's checked attribute and removes the
 * text, so both surfaces emit the same DOM (`li[data-item-type="task"][data-checked]`) and
 * CSS draws the mark. It runs before inline so that `[ ]` is taken out of the body before
 * it is split into children.
 */
export function taskListPlugin(md: MarkdownIt): void {
  md.core.ruler.before("inline", "task_list", (state) => {
    const { tokens } = state;
    for (let i = 2; i < tokens.length; i++) {
      const inline = tokens[i];
      const marker = opensListItem(tokens, i) ? TASK_MARKER.exec(inline.content) : null;
      if (marker?.groups) {
        inline.content = inline.content.slice(marker[0].length);
        const item = tokens[i - 2];
        item.attrSet("data-item-type", "task");
        item.attrSet("data-checked", marker.groups.mark === " " ? "false" : "true");
      }
    }
  });
}
