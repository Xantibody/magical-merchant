/**
 * The one rule that decides what a finger moving across a phone means. Several things want a
 * horizontal stroke (back from anywhere, a row's hidden actions, a row
 * of chips that scrolls sideways) and two want a vertical one (the list's own scroll, the bar
 * pushed up). Each of them deciding for itself would leave the winner to whichever listener ran
 * first; here the landing spot and the first few pixels of travel settle it once, and the
 * stroke keeps that meaning until the finger lifts.
 *
 * The rule, in words: a stroke to the right goes one level out. From a note that is its list,
 * from writing it is reading, and at the top of a surface there is nothing further out, so the
 * stroke is left alone (the places are on the pill, under the thumb). A stroke to the left
 * opens the row under the finger; on a wide window, off a row, it tucks the level beside the
 * page under it (the mirror of going out). Something that scrolls sideways keeps the strokes it
 * can still answer, and where text is being written the middle belongs to the caret, so only
 * the left edge goes out. Up on the bar raises the sheet. A list at its foot only scrolls:
 * search has one way in, the field at the foot, and a pull past the list would be a second one
 * that nothing on the screen shows.
 * A press held still on the foot's controls is not a stroke at all: the ring takes it
 * (`Ring.tsx` claims the finger through `palm-gestures.ts`).
 *
 * Vertical is the default. A thumb scrolling a list rarely moves straight up: its first pixels
 * arc sideways. So a stroke only counts as sideways once it runs clearly wider than tall, and
 * going out from the middle of the screen (rather than the edge) waits for a longer run, so a
 * scroll that drifts never slides the page away.
 *
 * Pure: the DOM side (`palm-gestures.ts`) reads the context off the page and acts on the answer.
 * The same rule answers a phone's finger and a wide window's two-finger trackpad swipe.
 */

/** What a stroke turned out to mean. */
export type GestureIntent =
  /** The screen slides right and the one below it shows through (60, 61). */
  | "back"
  /** A wide window: the level beside the page tucks under it (a note's list). */
  | "cover"
  /** The row slides left and its actions show behind it (25). */
  | "row"
  /** The bar is pushed up and the note's sheet rises from it (29). */
  | "sheet"
  /** The browser's own: a scroll, either way. */
  | "scroll"
  /** Nothing: the stroke is left alone (a caret drag, a stroke with nowhere to go). */
  | "none";

/** What is under the finger, read once when it lands. */
export interface GestureContext {
  /** Where the finger landed, from the window's left edge. */
  startX: number;
  /** Whether the screen has a level below it to go back to. */
  canGoBack: boolean;
  /** Whether the finger landed on a row that keeps actions behind it. */
  onRow: boolean;
  /**
   * Whether the finger landed in something that scrolls sideways, and which ways it can still
   * move: `back` toward its start (a stroke to the right), `on` toward its end (to the left).
   */
  sideScroll: { back: boolean; on: boolean } | null;
  /** Whether the finger landed where text is written (the editor, a field). */
  inText: boolean;
  /** Whether the finger landed on the bar at the foot, and a sheet can rise from it. */
  onSheetBar: boolean;
  /** A wide window only: whether a level beside the page can still be tucked under it. */
  canCover?: boolean;
}

/** How far a finger may wander before its stroke means anything (Chrome's own slop is 8px). */
const SLOP_PX = 10;

/**
 * How much wider than tall a stroke must run to count as sideways. At 1 (a 45° start) every
 * scroll that arcs a little was taken as a swipe; under about 1.5 a thumb's natural arc still
 * gets through. Past this a stroke is plainly meant across.
 */
const SIDEWAYS_RATIO = 1.8;

/**
 * How far a stroke from the middle of the screen runs before it goes out (back).
 * The edge needs no more than the slop: nothing else starts there.
 */
export const MIDDLE_TRAVEL_PX = 28;

/** How far a row is dragged before it is taken as opening (its own small slop). */
const ROW_TRAVEL_PX = 14;

/**
 * The strip along the left edge where a stroke to the right always goes out, even where the
 * middle is taken (by text, or by chips that still scroll). The system's own back gesture
 * starts in about the same width.
 */
export const EDGE_PX = 24;

/**
 * Decides a stroke from its landing context and how far it has travelled. `"pending"` until it
 * has moved past the slop (and, sideways from the middle, past its longer run); after that the
 * answer is final for the stroke (the caller keeps it). A diagonal is a scroll: vertical wins
 * every stroke that is not plainly sideways, so a drifting scroll is never taken over.
 */
export function decideGesture(
  context: GestureContext,
  dx: number,
  dy: number,
): GestureIntent | "pending" {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax * ax + ay * ay < SLOP_PX * SLOP_PX) {
    return "pending";
  }
  const sideways = ax > SIDEWAYS_RATIO * ay;
  if (!sideways) {
    // Only a stroke more tall than wide raises; the in-between is the scroll's
    if (ay > ax && dy < 0 && context.onSheetBar) {
      return "sheet";
    }
    return "scroll";
  }
  const edge = context.startX <= EDGE_PX;
  if (dx > 0) {
    if (!edge && context.sideScroll?.back) {
      return "scroll";
    }
    if (!edge && context.inText) {
      return "none";
    }
    // Out is one level back; at the top of a surface nothing lies further out
    if (!context.canGoBack) {
      return "none";
    }
    // From the middle the page waits for a longer run, so a short sideways flick on the way
    // to a tap or a scroll stays what it was
    return !edge && ax < MIDDLE_TRAVEL_PX ? "pending" : "back";
  }
  if (context.sideScroll?.on) {
    return "scroll";
  }
  if (context.onRow && !context.inText) {
    return ax < ROW_TRAVEL_PX ? "pending" : "row";
  }
  if (context.canCover && !context.inText) {
    return ax < MIDDLE_TRAVEL_PX ? "pending" : "cover";
  }
  return "none";
}

/** A stroke's end: how far it went along its axis and how fast it was going (px per ms). */
export interface StrokeEnd {
  distance: number;
  velocity: number;
}

/** A flick this fast counts as meant, however short. Slower than that, the distance decides. */
const FLICK = 0.45;

/** A flick still has to have travelled this far: a tap's wobble can be fast. */
const FLICK_MIN_PX = 24;

/**
 * Whether a stroke that slides a whole screen (back) goes through when the finger
 * lifts. Past a third of the way, or flung; otherwise it springs back. A stroke turned back
 * the other way at the end (velocity against it) springs back however far it went: that is
 * how a finger says "never mind" (61's cancel on release).
 */
export function commitsSlide(end: StrokeEnd, span: number): boolean {
  if (end.velocity < -FLICK / 2) {
    return false;
  }
  if (end.velocity > FLICK && end.distance > FLICK_MIN_PX) {
    return true;
  }
  return end.distance > span / 3;
}

/** How far a stroke draws a row's actions in to stand open: their own width. */
export const ROW_ACTIONS_PX = 196;

/**
 * Where a row's actions stand (their translateX) for a stroke that has come `travel` px (left is
 * negative): in from the row's right edge as far as the finger has come, and no further than
 * their place.
 *
 * Not the row sliding aside: a slid row lost its start, the time of a line or the title of a
 * note, so what was about to be acted on could no longer be read.
 */
export function rowDrawer(travel: number): number {
  return Math.min(ROW_ACTIONS_PX, Math.max(0, ROW_ACTIONS_PX + travel));
}

/** Whether a row let go stays open on its actions, or closes again. */
export function rowStaysOpen(end: StrokeEnd): boolean {
  if (end.velocity < -FLICK / 2) {
    return false;
  }
  return end.distance > ROW_ACTIONS_PX / 2 || (end.velocity > FLICK && end.distance > FLICK_MIN_PX);
}

/**
 * A slide's follow position, rubber-banded past its far end: the screen stops at its width and
 * gives only a little beyond it; it never moves the wrong way.
 */
export function slideFollow(dx: number, span: number): number {
  if (dx <= 0) {
    return 0;
  }
  if (dx <= span) {
    return dx;
  }
  return span + Math.sqrt(dx - span) * 2;
}

/** Two taps of two fingers within this long, and close together, toggle the page alone (85). */
export const DOUBLE_TAP_MS = 320;

/** How far apart (px) the two two-finger taps may land and still be one double tap. */
export const DOUBLE_TAP_PX = 40;
