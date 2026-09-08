import type { MarkdownIt, Token } from "markdown-it";

/** GFM の task list marker。後ろに空白が要るのは remark(エディタ側)と同じ。 */
const TASK_MARKER = /^\[(?<mark>[ xX])\] /u;

/** i 番目が、li 直下の最初の段落の inline か。marker はそこにしか立たない。 */
function opensListItem(tokens: Token[], i: number): boolean {
  return (
    tokens[i].type === "inline" &&
    tokens[i - 1].type === "paragraph_open" &&
    tokens[i - 2].type === "list_item_open"
  );
}

/**
 * `- [ ]` / `- [x]` を task の li にする markdown-it プラグイン。
 *
 * markdown-it は GFM の task list を知らず、`[ ]` を文字のまま出す。エディタ
 * (Milkdown の gfm)は同じ行を li の checked 属性に畳んで文字を消すので、
 * 両面で同じ DOM(`li[data-item-type="task"][data-checked]`)を出し、印は
 * CSS が描く。inline の前に走らせるのは、`[ ]` が children に割られる前に
 * 本文から外すため。
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
