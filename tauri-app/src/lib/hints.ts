/**
 * While ⌘ (Ctrl) is held, floats the keys that work right now on the buttons' shoulders.
 *
 * Vimium's "f labels every link" is the approach for a page with dozens of entry
 * points; this app has ten or so. Not enough to assign a letter per element, so
 * the shape chosen is: hold the modifier when you want to learn them and they
 * appear. The hidden actions do not turn into a permanent cheat sheet.
 *
 * The badge itself is drawn by the `data-hint-key` pseudo-element (`styles/base.css`),
 * so this only holds "show / hide". Not one DOM node is added.
 */

import { createSignal, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";

/** From press to badge. A normal shortcut, pressed and released at once, shows nothing. */
export const HINT_HOLD_MS = 300;

const MODIFIER_KEYS = new Set(["Meta", "Control"]);

/**
 * Keys that do nothing on their own and only accompany ⌘. The badge says "⌘⇧S",
 * so that ⇧ cannot be the key that hides the badge.
 */
const COMPANION_KEYS = new Set(["Shift", "Alt", "CapsLock"]);

export interface Hints {
  visible: Accessor<boolean>;
  keyDown: (e: KeyboardEvent) => void;
  keyUp: (e: KeyboardEvent) => void;
  hide: () => void;
}

/** A touch-only device has no modifier key. */
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
    if (!enabled || COMPANION_KEYS.has(e.key)) {
      return;
    }
    // A key other than a modifier means that shortcut is about to run. Badges
    // left on the screen it lands on make it unclear what just happened
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

  /** Hide the moment it is released. Releasing only ⇧ means ⌘ is still held. */
  const keyUp = (e: KeyboardEvent): void => {
    if (!COMPANION_KEYS.has(e.key)) {
      hide();
    }
  };

  return { visible, keyDown, keyUp, hide };
}
