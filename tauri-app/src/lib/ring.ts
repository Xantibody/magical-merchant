/**
 * Where the ring's choices stand (the reach's press-and-slide menu: 65, 68 and 93 folded into
 * one gesture). The choices come out of the control that was pressed as a fan of labelled
 * pills: stacked up from it, each bent a little further in from the edge, the way a thumb
 * sweeps from where it rests. Each pill keeps its round mark over the thumb's column and runs its
 * name into the screen, so a name is part of the thing it names.
 *
 * AIDEV-NOTE: the first build drew a true ring, round petals on an arc with their names floated
 * further out along each ray. From a phone's corner a quarter circle has no room for four
 * Japanese names: they were pushed apart until each stood beside the wrong petal, and on a wide
 * window they lay over the shelf's rows (round-1 review). A fan keeps the press-and-slide and the
 * one order, and its names cannot leave their pills.
 *
 * The first choice stands nearest the thumb, whichever corner the fan opens from, so the hand
 * learns one order. Pure geometry in screen coordinates (y grows downward); `Ring.tsx` draws it.
 */

import type { IconName } from "../components/Icon";
import { t } from "./i18n";
import { MODE_ICONS, ROUTES } from "./routes";

export interface Point {
  x: number;
  y: number;
}

/** One choice: what the thumb can start, or where it can go, from wherever it is. */
export interface RingChoice {
  id: string;
  icon: IconName;
  label: string;
  run: () => void;
}

/** What each choice does where the fan opened: the pill's are the app's, a list's its own. */
export interface RingActions {
  /** A line into Scrawl (68); on Scrawl itself, its own field. */
  jot: () => void;
  note: () => void;
  codex: () => void;
  template: () => void;
  /** Whether the fan opened on Scrawl, where the line is the field right there. */
  onScrawl?: boolean;
}

/**
 * The choices, in their one order (the first nearest the thumb): the line, the two kinds, the
 * templates. Every control that opens the fan builds it here, so a row means the same thing from
 * the pill, a list's + and a wide window's shelf. Search is not one of them: it already stands at
 * the foot of every list, of the shelf and in Scrawl's own `/`, and a fifth row would put the
 * last choice out of a thumb's reach.
 */
export function ringChoices(actions: RingActions): RingChoice[] {
  return [
    {
      id: "jot",
      icon: MODE_ICONS[ROUTES.SCRAWL],
      label: actions.onScrawl ? t().reach.writeHere : t().palm.jot,
      run: actions.jot,
    },
    { id: "note", icon: "note-pencil", label: t().reach.newNote, run: actions.note },
    { id: "codex", icon: "book", label: t().reach.newCodex, run: actions.codex },
    { id: "template", icon: "file-text", label: t().palm.fromTemplate, run: actions.template },
  ];
}

export interface Bounds {
  width: number;
  height: number;
}

/** The pressed control, as far as the fan cares: where along it the thumb is, and its edges. */
export interface RingAnchor {
  x: number;
  top: number;
  bottom: number;
}

export interface RingLayout {
  /** Which way the names run from their marks: into the screen, away from the nearer edge. */
  side: "left" | "right";
  /** Whether the fan rises from the control (it does, unless the glass above is too short). */
  up: boolean;
  /** Each choice's mark, in the choices' order. */
  petals: Point[];
  /** The fan's extent: the marks and the room the names take. A slide reads its rows inside it. */
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** A pill's height: a thumb's target, over the 44px floor. */
export const PILL_PX = 46;
/** From one pill's middle to the next: the pill and a gap that keeps them two things. */
export const STEP_PX = 56;
/** The round mark at the pill's thumb end. */
export const MARK_PX = 36;
/** The pill's own padding round the mark. */
export const MARK_PAD_PX = 5;
/**
 * The room a name takes beyond its mark: the widest drawn (the template choice in Japanese, eight
 * full-width characters at 15px) with the gap
 * before it and the padding after. Used to keep the fan on the glass and to give a slide the
 * whole pill, not to draw it: the pill sizes itself to its name.
 */
export const NAME_ROOM_PX = 150;
/** How far each pill bends in from the one below: 0, 1, 4, 9 times this, the thumb's arc. */
const BEND_PX = 6;
/** Between the control and the first pill. */
const GAP_PX = 10;
/** Nothing comes nearer the screen's edge than this. */
const EDGE_PX = 8;
/** A slide this far to the side of the pills has left them (7: it carries what it pressed). */
const BESIDE_PX = 40;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Lays `count` choices from the control at `anchor`. The names run toward the middle of the
 * screen, the pills rise from the control (or hang below it where the glass above is too short),
 * and each one bends a little further in. Every pill stays on the glass, its name included.
 */
export function ringLayout(anchor: RingAnchor, count: number, bounds: Bounds): RingLayout {
  const side = anchor.x > bounds.width / 2 ? "left" : "right";
  const inward = side === "left" ? -1 : 1;
  const span = count * STEP_PX;
  const up = anchor.top - GAP_PX - span >= EDGE_PX || anchor.bottom + GAP_PX + span > bounds.height;
  const markHalf = MARK_PX / 2 + MARK_PAD_PX;
  // The mark stays on the glass, and so does the name running from it
  const low = side === "left" ? EDGE_PX + markHalf + NAME_ROOM_PX : EDGE_PX + markHalf;
  const high =
    side === "left"
      ? bounds.width - EDGE_PX - markHalf
      : bounds.width - EDGE_PX - markHalf - NAME_ROOM_PX;
  const petals = Array.from({ length: count }, (_, i) => ({
    x: clamp(anchor.x + inward * BEND_PX * i * i, low, Math.max(low, high)),
    y: up
      ? anchor.top - GAP_PX - PILL_PX / 2 - i * STEP_PX
      : anchor.bottom + GAP_PX + PILL_PX / 2 + i * STEP_PX,
  }));
  // A press with nothing to choose (the pencil, carried from its first move) still has a place
  const xs = petals.length > 0 ? petals.map((p) => p.x) : [anchor.x];
  const ys = petals.length > 0 ? petals.map((p) => p.y) : [anchor.top];
  const nearest = side === "left" ? Math.max(...xs) + markHalf : Math.min(...xs) - markHalf;
  const furthest =
    side === "left"
      ? Math.min(...xs) - markHalf - NAME_ROOM_PX
      : Math.max(...xs) + markHalf + NAME_ROOM_PX;
  return {
    side,
    up,
    petals,
    left: Math.min(nearest, furthest),
    right: Math.max(nearest, furthest),
    top: Math.min(...ys) - PILL_PX / 2,
    bottom: Math.max(...ys) + PILL_PX / 2,
  };
}

/**
 * The choice whose row holds `point`, or -1. A row is the pill's whole band, gap included, and
 * the full width the fan takes: a thumb sliding up only has to cross into it.
 */
export function petalAt(layout: RingLayout, point: Point): number {
  if (point.x < layout.left - BESIDE_PX / 2 || point.x > layout.right + BESIDE_PX / 2) {
    return -1;
  }
  return layout.petals.findIndex((petal) => Math.abs(point.y - petal.y) <= STEP_PX / 2);
}

/**
 * Whether a slide has left the fan behind: beyond its far end by half a row, or well to one side
 * of it. A press that goes on past the fan carries what it held into the page instead (7). Back
 * toward the control is not past: that is the thumb changing its mind.
 */
export function pastRing(layout: RingLayout, point: Point): boolean {
  const beyond = layout.up
    ? point.y < layout.top - STEP_PX / 2
    : point.y > layout.bottom + STEP_PX / 2;
  return beyond || point.x < layout.left - BESIDE_PX || point.x > layout.right + BESIDE_PX;
}
