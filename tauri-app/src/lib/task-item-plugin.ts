import { $prose } from "@milkdown/kit/utils";
import { Plugin } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

/** その li を立てている list_item の checked を反転する。task でなければ何もしない。 */
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
 * task list の印を押したら checked を反転する。gfm プリセットは `- [ ]` を
 * list_item の checked 属性に畳むだけで、文字には残らず、印も切り替えも持たない
 * (印そのものは editor.css が li の ::before に描く)。
 *
 * 印は li の内容箱の左、ul の padding に置いてあるので、押された target が
 * li 自身で、内容箱より左なら印。mousedown で受けるのは、ProseMirror が
 * 押された座標にカーソルを置きに行く前に止めるため — 段落の文字を押した
 * ときは target が p なので通り過ぎ、いつもどおりカーソルが動く。
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
