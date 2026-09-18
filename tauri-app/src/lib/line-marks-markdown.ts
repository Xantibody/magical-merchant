import type { MarkdownIt, Token } from "markdown-it";
import { blockMark } from "./diff-marks";
import type { LineMark } from "./diff-marks";

/**
 * 履歴を開いているあいだの欄外の印。`env.marks`(行ごとの add / del)を、
 * ブロックの token に class として載せる — 描く側は差分を別枠に置かず、
 * 本文の色も字も変えない。印の DOM は `.diff-sign` の span 1 つだけで、
 * 変わったブロックにしか付かない。
 *
 * 印を付けるのは行を持つ「いちばん内側の」ブロック: 段落・見出し・罫線・
 * 表の行。ぴったり詰めた箇条書きの段落は描かれない(`hidden`)ので、その
 * 印は項目(`li`)に上げる。フェンスは描画が別経路なので `meta` に持たせ、
 * `markdown.ts` が `<pre>` に載せる。
 *
 * 段落の中の一部の行だけが消えたときは、段落ごと消したことにせず、その
 * 行の文字だけを `<s>` で括る。段落は行を柔らかい改行(softbreak)で
 * 繋いでいるので、その数で行を数える。
 */

export interface LineMarksEnv {
  marks?: readonly (LineMark | undefined)[];
}

const MARKED_BLOCKS: ReadonlySet<string> = new Set([
  "heading_open",
  "paragraph_open",
  "code_block",
  "hr",
  "tr_open",
]);

function applyMark(token: Token, mark: LineMark | undefined): void {
  if (mark) {
    token.attrJoin("class", `diff-mark diff-mark--${mark}`);
  }
}

/** 消えた行だけを `<s>` で括る。段落全体が消えたときは CSS が引くので呼ばない。 */
function strikeDeletedLines(
  inline: Token,
  marks: readonly (LineMark | undefined)[],
  makeToken: (type: string, tag: string, nesting: 1 | 0 | -1) => Token,
): void {
  if (!inline.map || !inline.children) {
    return;
  }
  let [line] = inline.map;
  const out: Token[] = [];
  let open = false;
  const openStrike = (): void => {
    const token = makeToken("s_open", "s", 1);
    token.attrSet("class", "diff-del-line");
    out.push(token);
    open = true;
  };
  const closeStrike = (): void => {
    out.push(makeToken("s_close", "s", -1));
    open = false;
  };
  if (marks[line] === "del") {
    openStrike();
  }
  for (const child of inline.children) {
    if (child.type === "softbreak" || child.type === "hardbreak") {
      if (open) {
        closeStrike();
      }
      out.push(child);
      line += 1;
      if (marks[line] === "del") {
        openStrike();
      }
    } else {
      out.push(child);
    }
  }
  if (open) {
    closeStrike();
  }
  inline.children = out;
}

/** 印の記号。段落の先頭に浮かせ、CSS が欄外へ出す。 */
function signToken(
  mark: LineMark,
  makeToken: (type: string, tag: string, nesting: 1 | 0 | -1) => Token,
): Token {
  const token = makeToken("html_inline", "", 0);
  token.content = `<span class="diff-sign" aria-hidden="true">${mark === "add" ? "+" : "−"}</span>`;
  return token;
}

export function lineMarksPlugin(markdownIt: MarkdownIt): void {
  markdownIt.core.ruler.push("line_marks", (state) => {
    const { marks } = state.env as LineMarksEnv;
    if (!marks) {
      return;
    }
    const makeToken = (type: string, tag: string, nesting: 1 | 0 | -1): Token =>
      new state.Token(type, tag, nesting);
    /** 開いている `li`。詰めた段落の印はここへ上げる。 */
    const items: Token[] = [];
    /** 直前に印を決めたブロック。次の inline token がその中身。 */
    let pending: { target: Token; mark: LineMark; partial: boolean } | undefined;

    /** 印を決めたブロックの中身(inline)に、記号と消えた行の打ち消しを入れる。 */
    const fillInline = (token: Token): void => {
      if (!pending) {
        return;
      }
      if (pending.partial) {
        strikeDeletedLines(token, marks, makeToken);
      }
      token.children?.unshift(signToken(pending.mark, makeToken));
      pending = undefined;
    };

    const markBlock = (token: Token): void => {
      if (!token.map) {
        return;
      }
      const [from, to] = token.map;
      const mark = blockMark(marks, from, to);
      if (token.type === "fence") {
        token.meta = { ...token.meta, mark };
        return;
      }
      if (!MARKED_BLOCKS.has(token.type) || !mark) {
        return;
      }
      const target = token.type === "paragraph_open" && token.hidden ? items.at(-1) : undefined;
      applyMark(target ?? token, mark);
      if (token.type === "paragraph_open" || token.type === "heading_open") {
        pending = { target: target ?? token, mark, partial: mark === "add" };
      }
    };

    for (const token of state.tokens) {
      if (token.type === "list_item_open") {
        items.push(token);
      } else if (token.type === "list_item_close") {
        items.pop();
      }
      if (token.type === "inline") {
        fillInline(token);
      } else {
        markBlock(token);
      }
    }
  });
}
