import { Plugin } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";
import { isImeComposing } from "./ime";

/**
 * Keeps a key that belongs to the IME away from every keymap.
 *
 * ProseMirror's own guard is Safari-only and holds for one key within 500ms of a compositionend
 * it saw while composing. An Enter outside that window reaches the keymaps, which read only
 * `event.key`, and the paragraph splits on the press that confirmed a conversion.
 *
 * AIDEV-NOTE: handleDOMEvents, not handleKeyDown. Returning true from handleKeyDown makes
 * ProseMirror call preventDefault, and the IME needs the event to finish its confirmation.
 */
export const imeKeyPlugin = $prose(
  () => new Plugin({ props: { handleDOMEvents: { keydown: (_view, e) => isImeComposing(e) } } }),
);
