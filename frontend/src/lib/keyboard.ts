/**
 * Tools for moving whatever sticks to the bottom of the screen above the soft keyboard.
 *
 * The tools placed at the bottom edge (the syntax toolbar, the variable insert row)
 * hide behind the keyboard the moment it appears. Hidden, they cannot be pressed,
 * so while the keyboard is open they are lifted to sit on its top edge.
 */

import { createSignal, onCleanup, onMount } from "solid-js";
import type { Accessor } from "solid-js";

/** A shrink up to this much is scrollbar or URL bar noise, not a keyboard. */
const KEYBOARD_MIN_HEIGHT = 100;

/**
 * The keyboard's top edge. Returns `undefined` while closed and leaves it to the
 * CSS `bottom: var(--safe-bottom)`.
 *
 * On Android `visualViewport.height` is the full height including the navigation
 * bar even when closed, so pinning `top` to that value pushes the tools under the bar.
 */
export function keyboardTop(
  viewport: { offsetTop: number; height: number },
  windowHeight: number,
): number | undefined {
  if (viewport.height >= windowHeight - KEYBOARD_MIN_HEIGHT) {
    return undefined;
  }
  return viewport.offsetTop + viewport.height;
}

/** Returns the keyboard's top edge only while it is open. `undefined` when closed. */
export function createKeyboardTop(): Accessor<number | undefined> {
  const [top, setTop] = createSignal<number | undefined>();

  onMount(() => {
    const vv = window.visualViewport;
    if (!vv) {
      return;
    }
    const update = (): void => {
      setTop(keyboardTop(vv, window.innerHeight));
    };

    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    onCleanup(() => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    });
  });

  return top;
}

/**
 * The style for sticking above the keyboard. Returns nothing while closed and
 * leaves the anchoring to the CSS `bottom`.
 */
export function keyboardTopStyle(
  top?: number,
): { top: string; bottom: string; transform: string } | undefined {
  return top === undefined
    ? undefined
    : { top: `${top}px`, bottom: "auto", transform: "translateY(-100%)" };
}
