import type { MarkdownIt, StateCore, Token } from "markdown-it";
import { splitGlyphs } from "./glyphs";

/** 描画時に渡す、名前 → データ URL の登録表。 */
interface GlyphEnv {
  glyphs?: ReadonlyMap<string, string>;
}

/** `<img>` 1 つぶんの HTML。`src` は登録表の値であって、本文の文字ではない。 */
function glyphImageHtml(md: MarkdownIt, shortcode: string, url: string): string {
  const alt = md.utils.escapeHtml(shortcode);
  return `<img class="glyph" src="${md.utils.escapeHtml(url)}" alt="${alt}" draggable="false">`;
}

function split(
  md: MarkdownIt,
  state: StateCore,
  token: Token,
  glyphs: ReadonlyMap<string, string>,
): Token[] {
  const segments = splitGlyphs(token.content, glyphs);
  if (!segments.some((segment) => segment.name !== null)) {
    return [token];
  }

  return segments.map((segment) => {
    const url = segment.name === null ? undefined : glyphs.get(segment.name);
    if (segment.name === null || url === undefined) {
      const text = new state.Token("text", "", 0);
      text.content = segment.text;
      return text;
    }
    const html = new state.Token("html_inline", "", 0);
    html.content = glyphImageHtml(md, segment.text, url);
    return html;
  });
}

/**
 * 本文の `:name:` を登録済みの画像にする markdown-it プラグイン。
 *
 * noteLinkPlugin と同じく `text` トークンだけを割るので、コードスパンや
 * フェンスの中の `:236p:` は文字のまま残る。
 */
export function glyphPlugin(md: MarkdownIt): void {
  md.core.ruler.push("glyph", (state) => {
    const { glyphs } = state.env as GlyphEnv;
    if (!glyphs || glyphs.size === 0) {
      return;
    }
    const inline = state.tokens.filter((block) => block.type === "inline" && block.children);
    for (const block of inline) {
      block.children =
        block.children?.flatMap((token) =>
          token.type === "text" ? split(md, state, token, glyphs) : [token],
        ) ?? null;
    }
  });
}
