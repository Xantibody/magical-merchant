/**
 * A tap in the viewer opens the writing screen with the caret near where the finger was (R3).
 *
 * The viewer (markdown-it) and the editor (ProseMirror) both draw the same body as a row of
 * top-level blocks, one per paragraph, heading, list, table or fence. So the spot is carried
 * over as "the Nth block, M characters in", measured on the viewer's DOM and laid back on the
 * editor's DOM. ProseMirror reads a DOM selection placed in its own tree on focus, so no
 * editor API (and none of its weight) is needed here.
 *
 * AIDEV-NOTE: not a mapping through the Markdown source. markdown-it's line map and
 * ProseMirror's positions would have to be joined over every node type; block + offset is
 * exact for text blocks and lands at worst on the right block's end for the rest.
 */

/** Where the tap landed, in terms both renderings share. */
export interface TapSpot {
  /** The index among the body's top-level blocks. */
  block: number;
  /** Characters of the block's text before the tap. */
  offset: number;
}

/**
 * What answers a tap on its own: links, buttons (code copy, diagram tools), checkboxes, tags,
 * diagrams (they zoom), images and the backlinks under the body.
 */
const OWN_BEHAVIOUR = [
  "a",
  "button",
  "input",
  "label",
  "select",
  "summary",
  "img",
  "video",
  "audio",
  "[data-action]",
  ".preview-tools",
  ".mermaid-block",
  ".tag-inline",
  ".backlinks",
].join(", ");

/** Whether a click in the viewer should open the writing screen. */
export function startsWriting(e: MouseEvent): boolean {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
    return false;
  }
  const target = e.target instanceof Element ? e.target : null;
  if (!target || target.closest(OWN_BEHAVIOUR)) {
    return false;
  }
  // A drag that selected text was a selection, not a tap: it is there to be copied
  const selection = globalThis.getSelection();
  return !selection || selection.isCollapsed;
}

/** The DOM position under a point, in whichever spelling the browser has. */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (doc.caretPositionFromPoint) {
    const position = doc.caretPositionFromPoint(x, y);
    return position ? { node: position.offsetNode, offset: position.offset } : null;
  }
  const range = document.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/** The top-level block of `root` that holds `node`, or null outside it. */
function blockOf(root: Element, node: Node): Element | null {
  let current: Node | null = node;
  while (current && current.parentNode !== root) {
    current = current.parentNode;
  }
  return current instanceof Element ? current : null;
}

/**
 * The text nodes that carry the block's words. markdown-it leaves a newline between the items
 * of a list or the cells of a table, where ProseMirror has none; counting them would push the
 * caret a character further on every item.
 */
function wordsOf(block: Element): TreeWalker {
  return document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      /^\s*\n\s*$/u.test(node.textContent ?? "")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
}

/** Characters of `block`'s words before (node, offset). */
function wordsBefore(block: Element, node: Node, offset: number): number {
  const walker = wordsOf(block);
  let count = 0;
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (text === node) {
      return count + offset;
    }
    count += text.textContent?.length ?? 0;
  }
  return count;
}

/** Where a click at (x, y) landed inside the viewer's `root`. Null when not on a block. */
export function tapSpot(root: Element, x: number, y: number, target: Node): TapSpot | null {
  const caret = caretAt(x, y);
  const block = blockOf(root, caret?.node ?? target) ?? blockOf(root, target);
  if (!block) {
    return null;
  }
  const index = [...root.children].indexOf(block);
  if (!caret || !block.contains(caret.node) || caret.node.nodeType !== Node.TEXT_NODE) {
    // On the block but not on its text (padding, a gap between items): its end
    return { block: index, offset: wordsBefore(block, block, 0) };
  }
  return { block: index, offset: wordsBefore(block, caret.node, caret.offset) };
}

/**
 * Where a carried pencil or + was let go (7): after the Nth top-level block, and inside a list,
 * after its Mth item. Blocks and items, not characters: the viewer draws a glyph as an image
 * where the editor keeps its shortcode as text, so counting characters across a list lands in
 * the middle of the wrong item.
 */
export interface DropSpot {
  block: number;
  item: number | null;
}

/** Where a drop would open a new line, and where to draw that line. */
export interface DropGap {
  spot: DropSpot;
  /** The height, in the window, of the gap the new line goes into. */
  y: number;
}

/** The index of the last of `elements` whose middle is above `y`, or -1. */
function lastAbove(elements: readonly Element[], y: number): number {
  let last = -1;
  for (const [i, element] of elements.entries()) {
    const box = element.getBoundingClientRect();
    if (box.top + box.height / 2 > y) {
      break;
    }
    last = i;
  }
  return last;
}

/** A list's own items. */
function itemsOf(list: Element): Element[] {
  return [...list.children].filter((child) => child.matches("li"));
}

/**
 * The gap a drop at height `y` falls into in the viewer's `root`: after the last block whose
 * middle is above it, and inside a list, after the last item whose middle is. Above the first
 * block's middle there is no gap: the page's first line has nothing before it to follow.
 */
export function gapAt(root: Element, y: number): DropGap | null {
  const blocks = [...root.children];
  const index = lastAbove(blocks, y);
  const block = blocks[index];
  if (!block) {
    return null;
  }
  // A drop inside a list (or the top half of the one just under the block) goes between items
  const next = blocks[index + 1];
  const list = [block, next].find((one) => one?.matches("ul, ol"));
  const listBox = list?.getBoundingClientRect();
  if (list && listBox && y >= listBox.top && y <= listBox.bottom) {
    const items = itemsOf(list);
    const after = lastAbove(items, y);
    const item = items[after];
    if (item) {
      const below = items[after + 1]?.getBoundingClientRect().top;
      const { bottom } = item.getBoundingClientRect();
      return {
        spot: { block: blocks.indexOf(list), item: after },
        y: below === undefined ? bottom + 2 : (bottom + below) / 2,
      };
    }
  }
  const box = block.getBoundingClientRect();
  const below = next?.getBoundingClientRect().top;
  return {
    spot: { block: index, item: null },
    y: below === undefined ? box.bottom + 6 : (box.bottom + below) / 2,
  };
}

/**
 * The element whose end a drop's new line follows in the editor: the block, or inside a list
 * the item's own line (its paragraph, not a list nested under it). With no spot, the body's last.
 */
function lineEnd(editor: Element, spot: DropSpot | null): Element | null {
  const block = spot ? editor.children.item(spot.block) : editor.lastElementChild;
  if (!block?.matches("ul, ol")) {
    return block;
  }
  const items = itemsOf(block);
  const item = spot && spot.item !== null ? items[spot.item] : items.at(-1);
  if (!item) {
    return block;
  }
  return [...item.children].find((child) => !child.matches("ul, ol")) ?? item;
}

/**
 * Focuses the editor with the caret at the end of the line a drop follows (`gapAt`), or at the
 * end of the body. The new line itself is the editor's to open (`open-line.ts`).
 */
export function placeCaretAfter(editor: HTMLElement, spot: DropSpot | null): void {
  editor.focus();
  const line = lineEnd(editor, spot) ?? editor;
  // An element-level point at its end: the editor reads it as the end of that line's content,
  // whatever widgets (a glyph, a checkbox) the line holds
  globalThis.getSelection()?.collapse(line, line.childNodes.length);
  line.scrollIntoView({ block: "nearest" });
}

/** The text node and offset `offset` characters into `block`, clamped to its end. */
function textPoint(block: Element, offset: number): { node: Node; offset: number } {
  const walker = wordsOf(block);
  let left = offset;
  let last: Text | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (left <= node.length) {
      return { node, offset: left };
    }
    left -= node.length;
    last = node;
  }
  return last
    ? { node: last, offset: last.length }
    : { node: block, offset: block.childNodes.length };
}

/**
 * Focuses the editor and puts the caret at `spot`, or at the end of the body when there is no
 * spot or the editor has fewer blocks than the viewer did.
 */
export function placeCaret(editor: HTMLElement, spot: TapSpot | null): void {
  editor.focus();
  const selection = globalThis.getSelection();
  if (!selection) {
    return;
  }
  const block = spot ? editor.children.item(spot.block) : null;
  const point = block
    ? textPoint(block, spot?.offset ?? 0)
    : textPoint(editor, editor.textContent?.length ?? 0);
  selection.collapse(point.node, point.offset);
  // Bring it into view: on a phone the keyboard is about to cover the lower half
  (point.node instanceof Element ? point.node : point.node.parentElement)?.scrollIntoView({
    block: "nearest",
  });
}
