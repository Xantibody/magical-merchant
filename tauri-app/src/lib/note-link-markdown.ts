import type { MarkdownIt, StateCore, Token } from "markdown-it";
import { noteLinkFile, splitNoteLinks } from "./note-link";

/** 描画時に渡す、ID → タイトルの解決表。 */
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
    // 指し先の消えたリンクはタイトルに化けさせず、保存形のまま見せる。
    // 表示文字が書いてあっても同じ — 無いノートを在るように見せない
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
 * 本文の `[[ID]]` をタイトル表示のリンクにする markdown-it プラグイン。
 *
 * tagPlugin と同じく `text` トークンだけを割るので、コードスパンや
 * フェンスの中身には手が入らない。
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
