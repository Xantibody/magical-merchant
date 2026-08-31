import type { MarkdownIt, StateCore, Token } from "markdown-it";
import { splitTagged } from "./tags";

/** `text` トークン 1 つを、本文とタグのトークン列に割る。 */
function split(md: MarkdownIt, state: StateCore, token: Token): Token[] {
  const segments = splitTagged(token.content);
  if (!segments.some((segment) => segment.tag)) {
    return [token];
  }

  return segments.map((segment) => {
    if (!segment.tag) {
      const text = new state.Token("text", "", 0);
      text.content = segment.text;
      return text;
    }
    const html = new state.Token("html_inline", "", 0);
    html.content = `<span class="tag-inline">${md.utils.escapeHtml(segment.text)}</span>`;
    return html;
  });
}

/**
 * 本文の `#タグ` に色を付ける markdown-it プラグイン。
 *
 * `text` トークンだけを割るので、コードスパンやフェンスの中身、リンクの
 * URL には手が入らない。それらは先に別のトークンとして切り出されている。
 */
export function tagPlugin(md: MarkdownIt): void {
  md.core.ruler.push("inline_tag", (state) => {
    const inline = state.tokens.filter((block) => block.type === "inline" && block.children);
    for (const block of inline) {
      block.children =
        block.children?.flatMap((token) =>
          token.type === "text" ? split(md, state, token) : [token],
        ) ?? null;
    }
  });
}
