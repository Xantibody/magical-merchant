import type { MarkdownIt, StateCore, Token } from "markdown-it";
import { splitGlyphs } from "./glyphs";

/** The name -> data URL registry passed at render time. */
interface GlyphEnv {
  glyphs?: ReadonlyMap<string, string>;
}

/** HTML for one `<img>`. `src` is the registry value, not text from the body. */
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
 * markdown-it plugin that turns `:name:` in the body into the registered image.
 *
 * Like noteLinkPlugin it splits only `text` tokens, so a `:236p:` inside a code
 * span or a fence stays as text.
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
