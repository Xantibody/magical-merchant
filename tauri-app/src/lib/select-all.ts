/**
 * Select-all in the writing screen.
 *
 * A press on the strip or the margin takes the caret out of the body. With the focus on no
 * field, ⌘A is then the page's select-all: it highlights the body without handing it to the
 * editor, so the next key neither deletes nor replaces it. These helpers aim the key back at
 * the body. (The viewer keeps the page's own select-all; see workspace.css.)
 */

import { isTypingTarget } from "./shortcuts";

/** ⌘A on a Mac, Ctrl+A elsewhere. Both are accepted, as in `matchesShortcut`. */
export function isSelectAll(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "a";
}

/**
 * Whether the key is the screen's to answer. A field and the editor select their own text,
 * which is what the person pressing it there wants, and a dialog keeps its keys.
 */
export function claimsSelectAll(e: KeyboardEvent): boolean {
  if (!isSelectAll(e) || e.defaultPrevented || isTypingTarget(e.target)) {
    return false;
  }
  return !(
    e.target instanceof Element &&
    e.target.closest('[role="dialog"], [role="menu"], .palette-overlay, .search')
  );
}

/** Selects everything inside `node`. Inside a focused editable, the editor reads it as its own. */
export function selectContents(node: Node): void {
  const selection = globalThis.getSelection();
  if (!selection) {
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
}
