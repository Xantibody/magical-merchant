import { NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
import type { Command, EditorState, Selection, Transaction } from "@milkdown/kit/prose/state";

/**
 * Whether the cursor (the start of the selection) is inside a code block. Everything that
 * means nothing outside a code block, the exit command, the Tab indent, whether to show
 * the toolbar's "leave the block", all use this one answer.
 */
export function isInCodeBlock(selection: Selection): boolean {
  return selection.$from.parent.type.name === "code_block";
}

/**
 * Make a paragraph right after the code block and move the cursor into it. The keyboard
 * binds it to Mod-Enter, but a phone has no modifier key, so the same command can also be
 * called from the toolbar.
 */
export const exitCodeBlock: Command = (state, dispatch) => {
  if (!isInCodeBlock(state.selection)) {
    return false;
  }
  const { $from } = state.selection;
  if (!dispatch) {
    return true;
  }

  const endOfBlock = $from.after($from.depth);
  const { tr } = state;
  tr.insert(endOfBlock, state.schema.nodes.paragraph.create());
  tr.setSelection(TextSelection.near(tr.doc.resolve(endOfBlock + 1)));
  dispatch(tr.scrollIntoView());
  return true;
};

const CODE_INDENT = "  ";

/**
 * The line-head positions (document coordinates) of the code block lines the selection
 * covers. undefined unless the selection fits inside one code block. A selection that ends
 * exactly at a line end does not include the next line.
 */
function codeLineStarts(state: EditorState): number[] | undefined {
  const { $from, $to } = state.selection;
  if (!isInCodeBlock(state.selection) || !$from.sameParent($to)) {
    return undefined;
  }
  const text = $from.parent.textContent;
  const base = $from.start();
  const starts = [text.lastIndexOf("\n", $from.parentOffset - 1) + 1];
  for (
    let i = text.indexOf("\n", starts[0]);
    i !== -1 && i + 1 < $to.parentOffset;
    i = text.indexOf("\n", i + 1)
  ) {
    starts.push(i + 1);
  }
  return starts.map((offset) => base + offset);
}

/**
 * Tab inside a code block indents. ProseMirror does not handle Tab, so letting it pass
 * moves the browser's focus to the next element and drops the writing hand out of the
 * editor. Two spaces because that is the most common width in a Markdown code block (a
 * tab character's displayed width varies by environment).
 *
 * With a range selected, it goes at the head of every one of those lines. With only a
 * cursor, it goes where the cursor is (a Tab mid-line should open space there, not at the
 * line head).
 */
export const indentCodeLine: Command = (state, dispatch) => {
  const starts = codeLineStarts(state);
  if (!starts) {
    return false;
  }
  if (!dispatch) {
    return true;
  }
  const { tr } = state;
  if (state.selection.empty) {
    tr.insertText(CODE_INDENT);
  } else {
    // Inserting from the last line backwards keeps the earlier lines' positions in place
    for (const start of starts.toReversed()) {
      tr.insertText(CODE_INDENT, start, start);
    }
  }
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Shift-Tab inside a code block takes one step of indent off the line head. With a range
 * selected, off every one of those lines. It reports the key handled even with nothing to
 * take off, so that focus does not escape outside.
 */
export const outdentCodeLine: Command = (state, dispatch) => {
  const starts = codeLineStarts(state);
  if (!starts) {
    return false;
  }
  if (!dispatch) {
    return true;
  }
  const text = state.selection.$from.parent.textContent;
  const base = state.selection.$from.start();
  const { tr } = state;
  for (const start of starts.toReversed()) {
    const indent = /^(?: {1,2}|\t)/u.exec(text.slice(start - base))?.[0];
    if (indent) {
      tr.delete(start, start + indent.length);
    }
  }
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * After the input rule replaces `---` with a horizontal rule, put the cursor in a new
 * paragraph below the rule. Milkdown's insertHrInputRule only replaces and does not set
 * the selection, so it ends with the rule itself selected (a NodeSelection). Typing the
 * next character there deletes the rule. Returns the tr to append, or null when there is
 * nothing to fix.
 *
 * If an empty paragraph already follows, it only moves there. At the end of the document
 * the trailing plugin has added an empty paragraph first, so adding one here too would
 * leave two blank lines.
 */
export function stepPastHr(state: EditorState): Transaction | null {
  const { selection } = state;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== "hr") {
    return null;
  }
  const after = selection.to;
  const { tr } = state;
  const next = state.doc.resolve(after).nodeAfter;
  if (!(next?.type.name === "paragraph" && next.content.size === 0)) {
    tr.insert(after, state.schema.nodes.paragraph.create());
  }
  tr.setSelection(TextSelection.create(tr.doc, after + 1));
  return tr;
}
