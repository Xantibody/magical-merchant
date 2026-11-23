import type { MarkdownIt, StateCore, Token } from "markdown-it";
import { splitTagged } from "./tags";

/** Split one `text` token into a run of body tokens and tag tokens. */
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
 * A markdown-it plugin that colours the `#tag` words in the body.
 *
 * It splits only `text` tokens, so the inside of a code span or a fence, and a link
 * URL, are left alone. Those have already been cut out as tokens of their own.
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
