/**
 * A fresh line where something was dropped (7): the + let go on a note, or the pencil let go
 * between two blocks of the page being read. The caret is first put where the drop was (the
 * end of the block above it, `tap-to-write.ts`), and then the line opens exactly as an Enter
 * pressed there would open it: a new item inside a list, a new task under a task, a new
 * paragraph after a paragraph. Going through the editor's own keymaps, not a command of its
 * own, keeps every rule they already have (the task item's, the code block's) in one place.
 */

import { editorViewCtx, serializerCtx } from "@milkdown/kit/core";
import type { Editor } from "@milkdown/kit/core";
import { splitBlock } from "@milkdown/kit/prose/commands";
import { TextSelection } from "@milkdown/kit/prose/state";

/**
 * Opens a new line at the DOM caret, as Enter would, and returns the body as it now reads, the
 * line still empty: the writer compares what the editor reports against it, and saves nothing
 * while they match (`Workspace.tsx`). Nothing happens, and nothing is returned, if the caret is
 * not in the body.
 */
export function openLineAtCaret(editor: Editor): string | undefined {
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const selection = globalThis.getSelection();
    const anchor = selection?.anchorNode;
    if (!selection || !anchor || !view.dom.contains(anchor)) {
      return;
    }
    // The DOM caret placed by the drop is read into the editor's own state first: its observer
    // would catch up on the next selectionchange, after the Enter below had already run
    const at = view.posAtDOM(anchor, selection.anchorOffset);
    const { doc } = view.state;
    view.dispatch(
      view.state.tr.setSelection(TextSelection.near(doc.resolve(Math.min(at, doc.content.size)))),
    );
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    const taken = view.someProp("handleKeyDown", (handle) => handle(view, enter)) ?? false;
    if (!taken) {
      splitBlock(view.state, view.dispatch);
    }
    view.focus();
    view.dispatch(view.state.tr.scrollIntoView());
    return ctx.get(serializerCtx)(view.state.doc);
  });
}
