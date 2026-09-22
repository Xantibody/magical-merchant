import { $shortcut } from "@milkdown/kit/utils";
import { indentCodeLine, outdentCodeLine } from "./block-commands";
import { nextTableCell } from "./table-commands";

/**
 * The catcher for a Tab / Shift-Tab that no list took.
 *
 * ProseMirror does not handle Tab, so pressing it outside a list (a paragraph, a code
 * block, a first item that cannot be sunk) makes the browser move focus to the next element
 * and drops the writing hand outside the editor. In a code block it indents; anywhere else
 * it does nothing but still counts as handled, so the cursor does not move.
 *
 * priority 0 puts it last (the default is 50, highest first). sinkListItem and the rest are
 * tried first, and this is reached only when they all refuse. Moving to the next table cell
 * is tried here, not before.
 */
export const tabKeymapPlugin = $shortcut(() => ({
  Tab: {
    key: "Tab",
    priority: 0,
    onRun: () => (state, dispatch) =>
      nextTableCell(state, dispatch) || indentCodeLine(state, dispatch) || true,
  },
  "Shift-Tab": {
    key: "Shift-Tab",
    priority: 0,
    onRun: () => (state, dispatch) => outdentCodeLine(state, dispatch) || true,
  },
}));
