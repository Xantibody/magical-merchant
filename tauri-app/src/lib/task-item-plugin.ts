import { $prose } from "@milkdown/kit/utils";
import { Plugin } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

/** Flips checked on the list_item that raised this li. Does nothing if it is not a task. */
function toggleTask(view: EditorView, li: HTMLElement): boolean {
  const $inside = view.state.doc.resolve(view.posAtDOM(li, 0));
  const item = $inside.parent;
  if (typeof item.attrs.checked !== "boolean") {
    return false;
  }
  view.dispatch(
    view.state.tr.setNodeMarkup($inside.before(), undefined, {
      ...item.attrs,
      checked: !item.attrs.checked,
    }),
  );
  return true;
}

/**
 * Pressing a task list marker flips checked. The gfm preset only folds `- [ ]` into the
 * list_item's checked attribute; it does not remain as text, and the preset carries neither
 * the marker nor the toggle (editor.css draws the marker itself on the li's ::before).
 *
 * The marker sits left of the li's content box, in the ul's padding, so a press is on the
 * marker when its target is the li itself and it is left of the content box. mousedown is
 * what is handled, to stop ProseMirror before it goes to place the cursor at the pressed
 * coordinates. A press on the text of a paragraph has p as its target, so it passes through
 * and the cursor moves as usual.
 */
export const taskItemPlugin = $prose(
  () =>
    new Plugin({
      props: {
        handleDOMEvents: {
          mousedown(view, event) {
            const { target } = event;
            if (!(target instanceof HTMLElement) || !target.matches('li[data-item-type="task"]')) {
              return false;
            }
            if (event.clientX >= target.getBoundingClientRect().left) {
              return false;
            }
            event.preventDefault();
            return toggleTask(view, target);
          },
        },
      },
    }),
);
