import { createEffect, createSignal, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";

/**
 * How far the on-screen keyboard reaches into the window. Android's WebView usually shrinks the
 * layout viewport with it, and then this is 0; where only the visual viewport shrinks, whatever
 * docks at the bottom is lifted by the difference so it stays above the keys.
 */
function keyboardInset(view: Pick<VisualViewport, "height" | "offsetTop">): number {
  return Math.max(0, Math.round(globalThis.innerHeight - view.height - view.offsetTop));
}

/** The keyboard inset, followed while `active` holds (only then does anything dock below). */
export function createKeyboardInset(active: Accessor<boolean>): Accessor<number> {
  const [inset, setInset] = createSignal(0);
  createEffect(() => {
    const view = globalThis.visualViewport;
    if (!active() || !view) {
      setInset(0);
      return;
    }
    const follow = (): void => {
      setInset(keyboardInset(view));
    };
    follow();
    view.addEventListener("resize", follow);
    view.addEventListener("scroll", follow);
    onCleanup(() => {
      view.removeEventListener("resize", follow);
      view.removeEventListener("scroll", follow);
    });
  });
  return inset;
}
