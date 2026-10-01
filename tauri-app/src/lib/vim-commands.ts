/**
 * What the Vim actions do to a ProseMirror document. `vim-plugin.ts` decides when.
 *
 * A "line" is a textblock (a paragraph, a heading, the text of a list item), except inside
 * a code block, where it is the text between two newlines: otherwise `dd` in a code block
 * would take the whole block. The unit `dd` / `yy` / `p` move is the line's block, and for
 * the first textblock of a list item that is the item, so a yanked item pastes as an item.
 */

import { Selection, TextSelection } from "@milkdown/kit/prose/state";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import { Fragment, Slice } from "@milkdown/kit/prose/model";
import type { Node, ResolvedPos } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import { chainCommands, splitBlock } from "@milkdown/kit/prose/commands";
import { splitListItem } from "@milkdown/kit/prose/schema-list";
import { splitTaskItem } from "./list-commands";
import type { InsertAt, VimMotion } from "./vim-keys";

export interface Line {
  from: number;
  to: number;
  /** Inside a code block, where a line ends at a newline rather than at the block's end. */
  code: boolean;
}

/** What `y`, `d` and `x` keep for `p`. One register: Vim's named ones are out of scope. */
export interface Register {
  slice: Slice;
  /** The plain text, for a code block and for the system clipboard. */
  text: string;
  linewise: boolean;
}

export function lineAt(doc: Node, pos: number): Line {
  const $pos = doc.resolve(pos);
  const { parent } = $pos;
  if (!parent.isTextblock) {
    return { from: pos, to: pos, code: false };
  }
  const start = $pos.start();
  if (!parent.type.spec.code) {
    return { from: start, to: $pos.end(), code: false };
  }
  const text = parent.textContent;
  const offset = $pos.parentOffset;
  const lineStart = offset === 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
  const newline = text.indexOf("\n", offset);
  return {
    from: start + lineStart,
    to: start + (newline === -1 ? text.length : newline),
    code: true,
  };
}

/** Where the block cursor may stand: on a character, never past the last one. */
export function clampToLine(doc: Node, pos: number): number {
  const line = lineAt(doc, pos);
  return Math.max(line.from, Math.min(pos, line.to - 1));
}

/** A collapsed selection at `pos`, or the nearest one when `pos` is not inside text. */
export function caretAt(doc: Node, pos: number): Selection {
  const $pos = doc.resolve(pos);
  return $pos.parent.inlineContent ? TextSelection.create(doc, pos) : Selection.near($pos);
}

/**
 * The node a whole-line command takes: the textblock, or its list item when it is the
 * item's first block.
 */
function lineBlock(doc: Node, pos: number): { from: number; to: number } {
  const $pos = doc.resolve(pos);
  let { depth } = $pos;
  if (depth > 1 && $pos.node(depth - 1).type.name === "list_item" && $pos.index(depth - 1) === 0) {
    depth -= 1;
  }
  return { from: $pos.before(depth), to: $pos.after(depth) };
}

/**
 * Where the caret lands one drawn line down or up (Vim's `gj` / `gk`: prose wraps). The
 * editor's own geometry answers, so every engine agrees: WebKit will not move a selection by
 * line inside a non-editable element, and the body is one outside insert. Probing in half
 * lines from the caret's edge crosses the gap between blocks; a wide figure in the way is
 * not crossed, and the caret stays.
 */
function lineMove(view: EditorView, head: number, direction: 1 | -1): number {
  const from = view.coordsAtPos(head);
  const half = Math.max(from.bottom - from.top, 1) / 2;
  for (let step = 1; step <= 16; step += 1) {
    const top = direction > 0 ? from.bottom + step * half : from.top - step * half;
    const found = view.posAtCoords({ left: from.left, top });
    // The gap between two blocks answers with a position between them, in no text at all
    if (found && view.state.doc.resolve(found.pos).parent.inlineContent) {
      const at = view.coordsAtPos(found.pos);
      const middle = (at.top + at.bottom) / 2;
      if (direction > 0 ? middle > from.bottom : middle < from.top) {
        return found.pos;
      }
    }
  }
  return head;
}

/** Words as the platform breaks them: the only word break that works in Japanese text. */
const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** The offsets at which the words of `text` start. Punctuation and spaces are not words. */
function wordStarts(text: string): number[] {
  const starts: number[] = [];
  for (const segment of segmenter.segment(text)) {
    if (segment.isWordLike) {
      starts.push(segment.index);
    }
  }
  return starts;
}

/** The textblock around `pos`, as the text its positions index: an inline atom counts one. */
function blockText($pos: ResolvedPos): string {
  return $pos.parent.textBetween(0, $pos.parent.content.size, undefined, "￼");
}

/**
 * The start of the next word (`w`) or the previous one (`b`). Past the last word of a
 * textblock, `w` goes on to the next block's first word; `b` back to the previous block's last.
 */
function wordMove(doc: Node, head: number, direction: 1 | -1): number {
  const $pos = doc.resolve(head);
  if (!$pos.parent.isTextblock) {
    return head;
  }
  const offset = $pos.parentOffset;
  const starts = wordStarts(blockText($pos));
  const inBlock =
    direction > 0
      ? starts.find((start) => start > offset)
      : starts.findLast((start) => start < offset);
  if (inBlock !== undefined) {
    return $pos.start() + inBlock;
  }
  const edge = direction > 0 ? $pos.after() : $pos.before();
  const next = Selection.findFrom(doc.resolve(edge), direction, true);
  if (!next) {
    return head;
  }
  const $next = next.$from;
  const nextStarts = wordStarts(blockText($next));
  const landing = direction > 0 ? nextStarts[0] : nextStarts.at(-1);
  return $next.start() + (landing ?? 0);
}

export function motionTarget(view: EditorView, head: number, motion: VimMotion): number {
  const { doc } = view.state;
  const line = lineAt(doc, head);
  switch (motion) {
    case "left": {
      return Math.max(line.from, head - 1);
    }
    case "right": {
      return Math.min(Math.max(line.from, line.to - 1), head + 1);
    }
    case "line-start": {
      return line.from;
    }
    case "line-end": {
      return Math.max(line.from, line.to - 1);
    }
    case "doc-start": {
      return Selection.atStart(doc).from;
    }
    case "doc-end": {
      return lineAt(doc, Selection.atEnd(doc).from).from;
    }
    case "down": {
      return lineMove(view, head, 1);
    }
    case "up": {
      return lineMove(view, head, -1);
    }
    case "word-forward": {
      return wordMove(doc, head, 1);
    }
    case "word-backward": {
      return wordMove(doc, head, -1);
    }
  }
}

/**
 * The selection visual mode shows. Charwise it covers the character under the cursor at
 * both ends, as Vim's does; linewise it runs from the first line's start to the last's end.
 */
export function visualSelection(
  doc: Node,
  anchor: number,
  head: number,
  linewise: boolean,
): Selection {
  if (linewise) {
    const [first, last] = anchor <= head ? [anchor, head] : [head, anchor];
    const { from } = lineAt(doc, first);
    const { to } = lineAt(doc, last);
    return anchor <= head
      ? TextSelection.between(doc.resolve(from), doc.resolve(to))
      : TextSelection.between(doc.resolve(to), doc.resolve(from));
  }
  const past = (pos: number): number => Math.min(pos + 1, lineAt(doc, pos).to);
  return head >= anchor
    ? TextSelection.between(doc.resolve(anchor), doc.resolve(past(head)))
    : TextSelection.between(doc.resolve(past(anchor)), doc.resolve(head));
}

/** Code lines count as lines only inside one block; across two, V takes the blocks whole. */
function inOneCodeBlock(doc: Node, first: number, last: number): boolean {
  return (
    lineAt(doc, first).code &&
    lineAt(doc, last).code &&
    doc.resolve(first).start() === doc.resolve(last).start()
  );
}

/** The range a visual operator acts on: the selection, or for linewise the whole blocks. */
function visualRange(
  doc: Node,
  anchor: number,
  head: number,
  linewise: boolean,
): { from: number; to: number } {
  if (!linewise) {
    const { from, to } = visualSelection(doc, anchor, head, false);
    return { from, to };
  }
  const [first, last] = anchor <= head ? [anchor, head] : [head, anchor];
  const firstLine = lineAt(doc, first);
  const lastLine = lineAt(doc, last);
  if (inOneCodeBlock(doc, first, last)) {
    return { from: firstLine.from, to: lastLine.to };
  }
  return { from: lineBlock(doc, first).from, to: lineBlock(doc, last).to };
}

function registerOf(doc: Node, from: number, to: number, linewise: boolean): Register {
  return {
    slice: doc.slice(from, to),
    text: doc.textBetween(from, to, "\n"),
    linewise,
  };
}

/** The whole line under `head`, as `yy` keeps it. */
export function yankLine(state: EditorState, head: number): Register {
  const line = lineAt(state.doc, head);
  if (line.code) {
    return registerOf(state.doc, line.from, line.to, true);
  }
  const block = lineBlock(state.doc, head);
  const node = state.doc.nodeAt(block.from);
  return {
    slice: node ? new Slice(Fragment.from(node), 0, 0) : Slice.empty,
    text: state.doc.textBetween(block.from, block.to, "\n"),
    linewise: true,
  };
}

/**
 * The range that removes the code lines `from`..`to` as lines: with the newline after them,
 * or before them at the block's end, and the whole block when they are all of it.
 */
function codeLinesRange(doc: Node, from: number, to: number): { from: number; to: number } {
  const $pos = doc.resolve(from);
  const start = $pos.start();
  const end = $pos.end();
  if (from === start && to === end) {
    return { from: $pos.before(), to: $pos.after() };
  }
  return to < end ? { from, to: to + 1 } : { from: from - 1, to };
}

/** `dd`. The cursor lands on the line that took its place. */
export function deleteLine(state: EditorState, head: number): Transaction {
  const line = lineAt(state.doc, head);
  const { tr } = state;
  if (line.code) {
    const range = codeLinesRange(state.doc, line.from, line.to);
    tr.delete(range.from, range.to);
  } else {
    const block = lineBlock(state.doc, head);
    // deleteRange takes a parent left empty (a list's only item) along with it
    tr.deleteRange(block.from, block.to);
  }
  const at = Math.min(tr.mapping.map(line.from), tr.doc.content.size);
  tr.setSelection(Selection.near(tr.doc.resolve(at)));
  return tr;
}

/** `x`. Nothing on an empty line. */
export function deleteChar(state: EditorState, head: number): Transaction | null {
  const line = lineAt(state.doc, head);
  if (head >= line.to) {
    return null;
  }
  const tr = state.tr.delete(head, head + 1);
  return tr.setSelection(caretAt(tr.doc, clampToLine(tr.doc, head)));
}

export function charRegister(state: EditorState, head: number): Register {
  return registerOf(state.doc, head, head + 1, false);
}

/** `p` / `P`. Linewise after / before the line's block; charwise after / at the cursor. */
export function put(
  state: EditorState,
  head: number,
  register: Register,
  before: boolean,
): Transaction {
  const line = lineAt(state.doc, head);
  const { tr } = state;
  if (!register.linewise) {
    const pos = before ? head : Math.min(head + 1, line.to);
    tr.replace(pos, pos, register.slice);
    const end = tr.mapping.mapResult(pos, 1).pos;
    return tr.setSelection(caretAt(tr.doc, Math.max(pos, end - 1)));
  }
  if (line.code) {
    if (before) {
      tr.insertText(`${register.text}\n`, line.from);
      return tr.setSelection(caretAt(tr.doc, line.from));
    }
    tr.insertText(`\n${register.text}`, line.to);
    return tr.setSelection(caretAt(tr.doc, line.to + 1));
  }
  const block = lineBlock(state.doc, head);
  const pos = before ? block.from : block.to;
  tr.replace(pos, pos, register.slice);
  const found = Selection.findFrom(tr.doc.resolve(Math.min(pos, tr.doc.content.size)), 1, true);
  return found ? tr.setSelection(found) : tr;
}

/** The register a visual operator keeps. */
export function visualRegister(
  state: EditorState,
  anchor: number,
  head: number,
  linewise: boolean,
): Register {
  const { from, to } = visualRange(state.doc, anchor, head, linewise);
  return registerOf(state.doc, from, to, linewise);
}

/**
 * Visual `d` / `c`. Linewise, `d` takes the lines away whole and `c` leaves one empty line
 * to write on, as Vim's `V c` does.
 */
export function deleteVisual(
  state: EditorState,
  anchor: number,
  head: number,
  linewise: boolean,
  op: "delete" | "change",
): Transaction {
  const { doc } = state;
  const { tr } = state;
  let { from, to } = visualRange(doc, anchor, head, linewise);
  if (linewise) {
    const [first, last] = anchor <= head ? [anchor, head] : [head, anchor];
    const firstLine = lineAt(doc, first);
    const lastLine = lineAt(doc, last);
    if (op === "change") {
      ({ from } = firstLine);
      ({ to } = lastLine);
      tr.delete(from, to);
    } else if (inOneCodeBlock(doc, first, last)) {
      ({ from, to } = codeLinesRange(doc, firstLine.from, lastLine.to));
      tr.delete(from, to);
    } else {
      // deleteRange takes a parent left empty (a list's only item) along with it
      tr.deleteRange(from, to);
    }
  } else {
    tr.delete(from, to);
  }
  const at = Math.min(tr.mapping.map(from), tr.doc.content.size);
  return tr.setSelection(Selection.near(tr.doc.resolve(at)));
}

/** Where `i a I A` leave the caret. */
export function insertPosition(state: EditorState, head: number, at: InsertAt): number {
  const line = lineAt(state.doc, head);
  switch (at) {
    case "after": {
      return Math.min(head + 1, line.to);
    }
    case "line-start": {
      return line.from;
    }
    case "line-end": {
      return line.to;
    }
    default: {
      return head;
    }
  }
}

/** The same split Enter makes: a task stays unchecked, a list item makes an item. */
const split = chainCommands(
  splitTaskItem,
  (state, dispatch) => splitListItem(state.schema.nodes.list_item)(state, dispatch),
  splitBlock,
);

/**
 * `o` / `O`: a new line below / above, made by the same split Enter makes, so in a list
 * it is a new item. Dispatches through `dispatch`; returns false when nothing could split.
 */
export function openLine(
  view: EditorView,
  head: number,
  below: boolean,
  dispatch: (tr: Transaction) => void,
): boolean {
  const line = lineAt(view.state.doc, head);
  if (line.code) {
    const tr = view.state.tr.insertText("\n", below ? line.to : line.from);
    dispatch(tr.setSelection(caretAt(tr.doc, below ? line.to + 1 : line.from)));
    return true;
  }
  dispatch(view.state.tr.setSelection(caretAt(view.state.doc, below ? line.to : line.from)));
  if (!split(view.state, dispatch)) {
    return false;
  }
  if (!below) {
    // Split at the start, the caret stays with the text below. The new line is the one above
    const { $from } = view.state.selection;
    const above = Selection.findFrom(view.state.doc.resolve($from.before()), -1, true);
    if (above) {
      dispatch(view.state.tr.setSelection(above));
    }
  }
  return true;
}
