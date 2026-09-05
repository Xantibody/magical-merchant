/**
 * ⌘(Ctrl)を押し続けているあいだだけ、いま押せるキーをボタンの肩に浮かせる。
 *
 * Vimium の「f で全リンクにラベル」は入口が数十あるページのやり方で、この
 * アプリの入口は10個に満たない。要素ごとに英字を振るほどではなく、覚えたい
 * ときだけ修飾キーを持ち続ければ出る、という形にした。隠しアクションを
 * 常設のチートシートに変えずに済む。
 *
 * 札そのものは `data-key` の擬似要素が描く(`styles/base.css`)ので、ここは
 * 「出す / 出さない」だけを持つ。DOM は 1 ノードも増えない。
 */

import { createSignal, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";

/** 押し始めてから札が出るまで。押してすぐ離す普通のショートカットでは出ない。 */
export const HINT_HOLD_MS = 300;

const MODIFIER_KEYS = new Set(["Meta", "Control"]);

export interface Hints {
  visible: Accessor<boolean>;
  keyDown: (e: KeyboardEvent) => void;
  hide: () => void;
}

/** タッチしかない端末には修飾キーが無い。 */
function supportsHover(): boolean {
  return !globalThis.matchMedia("(hover: none)").matches;
}

export function createHints(enabled: boolean = supportsHover()): Hints {
  const [visible, setVisible] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const hide = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    setVisible(false);
  };
  onCleanup(hide);

  const keyDown = (e: KeyboardEvent): void => {
    if (!enabled) {
      return;
    }
    // 修飾キー以外が来たということは、そのショートカットが走るということ。
    // 走った先の画面に札が残っていると、何が起きたのか分からなくなる
    if (!MODIFIER_KEYS.has(e.key)) {
      hide();
      return;
    }
    if (timer || visible()) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      setVisible(true);
    }, HINT_HOLD_MS);
  };

  return { visible, keyDown, hide };
}
