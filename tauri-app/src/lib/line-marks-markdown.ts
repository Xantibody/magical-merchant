import type { MarkdownIt, Token } from "markdown-it";
import { blockMark } from "./diff-marks";
import type { LineMark } from "./diff-marks";

/**
 * Gutter signs while the history is open. Puts `env.marks` (add / del per line)
 * onto the block tokens as a class. The renderer does not place the diff in a
 * separate frame, and neither the colour nor the text of the body changes. The
 * sign's DOM is a single `.diff-sign` span, attached only to a changed block.
 *
 * Signs go on the "innermost" block that owns lines: paragraph, heading, rule,
 * table row. The paragraph of a tight list item is not rendered (`hidden`), so
 * its sign moves up to the item (`li`). A fence is rendered by a separate path,
 * so it carries the sign in `meta` and `markdown.ts` puts it on the `<pre>`.
 *
 * When only some lines inside a paragraph were deleted, the paragraph is not
 * treated as deleted: only those lines' text is wrapped in `<s>`. A paragraph joins
 * its lines with soft line breaks (softbreak), so lines are counted by those.
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

/** Wraps only the deleted lines in `<s>`. Not called when the whole paragraph is deleted; CSS strikes that. */
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

/** The sign glyph. Floated at the head of the paragraph; CSS moves it into the gutter. */
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
    /** Open `li` tokens. The sign of a tight paragraph moves up to here. */
    const items: Token[] = [];
    /** The block whose sign was just decided. The next inline token is its content. */
    let pending: { target: Token; mark: LineMark; partial: boolean } | undefined;

    /** Puts the sign and the strike-through of deleted lines into the content (inline) of a marked block. */
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
