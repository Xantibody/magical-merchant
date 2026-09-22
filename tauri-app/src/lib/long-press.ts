/**
 * Long-press detection for touch devices. Returned as a bundle of pointer event
 * handlers that the element wires up directly.
 *
 * The mouse is not covered. A PC has buttons that appear on hover, and a mouse
 * long press only collides with dragging and text selection, gaining nothing.
 */

interface PointerLike {
  pointerType: string;
  clientX: number;
  clientY: number;
}

interface PointLike {
  clientX: number;
  clientY: number;
}

interface Cancelable {
  preventDefault: () => void;
}

/**
 * Movement (px) forgiven as finger wobble. Beyond this it is the start of a scroll.
 */
// AIDEV-NOTE: 10px is a little wider than Chrome's touch slop (8px). At 0 the jitter of a resting finger cannot complete the 500ms (#253)
const SLIP_PX = 10;

export interface LongPress {
  onPointerDown: (e: PointerLike) => void;
  onPointerUp: () => void;
  onPointerMove: (e: PointLike) => void;
  onPointerCancel: () => void;
  /**
   * No OS menu over an element that has a long press. To the WebView a held finger
   * is the start of a text selection, and left alone the "Copy" menu cuts into the
   * long press's feedback. Stopping the selection itself is the element's
   * `.long-press` (base.css); this side catches Android's contextmenu
   */
  onContextMenu: (e: Cancelable) => void;
  /**
   * Whether the click that follows may be handled as is. Lifting the finger after a
   * long press fired makes the browser send a click too; swallow just that one.
   */
  shouldClick: () => boolean;
}

export function createLongPress(onLongPress: () => void, holdMs = 500): LongPress {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired = false;
  /** Where the finger landed. Distance from here is the only measure of "moved". */
  let origin: PointLike | undefined;

  const cancel = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return {
    onPointerDown: (e) => {
      if (e.pointerType === "mouse") {
        return;
      }
      cancel();
      // The click that follows the previous long press, if it comes, comes before
      // this pointerdown. If the flag is still up, this device sends no click, and this tap is innocent
      // AIDEV-NOTE: The flag is dropped by the next pointerdown. A grace timer would make "how long to wait" device dependent
      fired = false;
      // The wobble allowance is measured afresh on each press. A finger that drifted
      // a little does not start the second press already at the full allowance
      origin = { clientX: e.clientX, clientY: e.clientY };
      timer = setTimeout(() => {
        timer = undefined;
        fired = true;
        onLongPress();
      }, holdMs);
    },
    onPointerUp: cancel,
    /**
     * pointermove keeps coming even from a finger that only rests. Giving up on the
     * first one means a long press never completes on a real device, so give up only
     * when the finger has left the landing spot.
     */
    onPointerMove: (e) => {
      if (!timer || !origin) {
        return;
      }
      const dx = e.clientX - origin.clientX;
      const dy = e.clientY - origin.clientY;
      if (dx * dx + dy * dy > SLIP_PX * SLIP_PX) {
        cancel();
      }
    },
    onPointerCancel: () => {
      cancel();
      // The OS took over the gesture during the press. No click will come
      fired = false;
    },
    onContextMenu: (e) => e.preventDefault(),
    shouldClick: () => {
      if (fired) {
        fired = false;
        return false;
      }
      return true;
    },
  };
}
