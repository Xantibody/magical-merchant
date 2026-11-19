/** The part of a trigger's box that decides where its popover hangs. */
interface TriggerBox {
  top: number;
  bottom: number;
  right: number;
}

/** Where a fixed popover stands, as the offsets to write on it (an element's `style`). */
type PopoverPlace =
  | Record<"top" | "bottom" | "right", string>
  | Record<"top" | "right", string>
  | Record<never, string>;

/** The air between a trigger and its popover, and between a popover and the window's edge. */
const GAP_PX = 8;

/**
 * Where a popover hangs so that it opens beside the button that opened it: over a trigger at
 * the foot (where every control of the reach is), below one with no room above, its right edge
 * on the trigger's.
 *
 * A fixed place in the stylesheet was right while the calendar's button was in a header at the
 * top. Built from the foot, the button moved down and the popover stayed up, a screen away
 * from the thumb that pressed it.
 */
export function placeBesideTrigger(
  trigger: TriggerBox | undefined,
  viewport: { width: number; height: number },
  popoverHeight: number,
): PopoverPlace {
  if (!trigger) {
    return {};
  }
  const right = `${Math.max(GAP_PX, Math.round(viewport.width - trigger.right))}px`;
  if (trigger.top - GAP_PX >= popoverHeight) {
    // `top: auto` lets go of the stylesheet's own top: with both set the box would stretch
    return {
      top: "auto",
      bottom: `${Math.round(viewport.height - trigger.top + GAP_PX)}px`,
      right,
    };
  }
  return { top: `${Math.round(trigger.bottom + GAP_PX)}px`, right };
}
