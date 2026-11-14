import type { JSX } from "solid-js";
import { shortcutLabel } from "../lib/shortcuts";

interface SheetGripProps {
  /** What a click does, said in words: "tuck the list", "bring the list back". */
  label: string;
  /** Whether the level a click moves stands out beside the page. */
  open: boolean;
  /** A click: the level right beside the page goes under it or comes back. */
  onToggle: () => void;
  /** A drag to the left: the nearest level still out goes under the page. */
  onCover: () => void;
  /** A drag to the right: the nearest level under the page comes back out. */
  onOut: () => void;
}

/** How far a held grip is dragged before a level goes or comes. */
const DRAG_PX = 36;

/**
 * The one handle on a wide window's page sheet, the pointer's half of the two-finger stroke.
 * A click moves the level right beside the page (a note's list). A drag runs the stroke's rule
 * instead: left tucks the list, right brings it back. It steps once per press, so a hand that
 * keeps going does not flick it back.
 */
export default function SheetGrip(props: SheetGripProps): JSX.Element {
  let startX = 0;
  let moved = false;
  let held = false;

  return (
    <button
      type="button"
      class="sheet-grip sheet-grip--list"
      title={props.label}
      aria-label={props.label}
      aria-expanded={props.open}
      data-hint-key={shortcutLabel("sidebar")}
      onPointerDown={(e) => {
        held = true;
        moved = false;
        startX = e.clientX;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // A pointer already gone cannot be captured; the moves over the grip still arrive
        }
      }}
      onPointerMove={(e) => {
        if (!held || moved) {
          return;
        }
        const dx = e.clientX - startX;
        if (Math.abs(dx) < DRAG_PX) {
          return;
        }
        moved = true;
        if (dx < 0) {
          props.onCover();
        } else {
          props.onOut();
        }
      }}
      onPointerUp={() => {
        held = false;
      }}
      onPointerCancel={() => {
        held = false;
      }}
      onClick={() => {
        if (!moved) {
          props.onToggle();
        }
        moved = false;
      }}
    >
      <span class="sheet-grip-bar" aria-hidden="true" />
    </button>
  );
}
