import type { MarkdownIt, StateCore, Token } from "markdown-it";
import { noteLinkFile, splitNoteLinks } from "./note-link";

/** The resolution table from ID to title, passed in at render time. */
interface NoteLinkEnv {
  noteTitles?: ReadonlyMap<string, string>;
}

function split(
  md: MarkdownIt,
  state: StateCore,
  token: Token,
  titles: ReadonlyMap<string, string>,
): Token[] {
  const segments = splitNoteLinks(token.content);
  if (!segments.some((segment) => segment.id !== null && titles.has(segment.id))) {
    return [token];
  }

  return segments.map((segment) => {
    const title = segment.id === null ? undefined : titles.get(segment.id);
    // A link whose target is gone does not become a title; it is shown in its saved form.
    // The same holds with display text written: a note that is not there is not made to look like it is
    if (segment.id === null || title === undefined) {
      const text = new state.Token("text", "", 0);
      text.content = segment.text;
      return text;
    }
    const label = segment.alias ?? title;
    const html = new state.Token("html_inline", "", 0);
    html.content = `<a class="note-link" data-file="${noteLinkFile(segment.id)}">${md.utils.escapeHtml(label)}</a>`;
    return html;
  });
}

/**
 * The markdown-it plugin that turns `[[ID]]` in the body into a link shown as a title.
 *
 * Like tagPlugin it splits only `text` tokens, so it never reaches inside a code span or
 * a fence.
 */
export function noteLinkPlugin(md: MarkdownIt): void {
  md.core.ruler.push("note_link", (state) => {
    const titles = (state.env as NoteLinkEnv).noteTitles;
    if (!titles || titles.size === 0) {
      return;
    }
    const inline = state.tokens.filter((block) => block.type === "inline" && block.children);
    for (const block of inline) {
      block.children =
        block.children?.flatMap((token) =>
          token.type === "text" ? split(md, state, token, titles) : [token],
        ) ?? null;
    }
  });
}
