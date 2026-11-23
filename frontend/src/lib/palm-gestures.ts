/**
 * The DOM side of the gesture rule (`gesture.ts`): reads what is under a landing finger, asks
 * the rule what the stroke means, then lets the screen or a row follow the finger and settle
 * when it lifts.
 *
 * Touch events, not pointer events. A pointer stream is cancelled the moment the browser takes
 * a stroke for its own scroll; touchmove keeps arriving either way. A mouse has none of this: on a wide
 * window every one of these strokes has a visible control instead (the shelf's rail stands beside
 * the page, a row shows its actions on hover, the search button is at the foot of the rail).
 *
 * One listener on the app, not one per surface, so the rule is the only arbiter: a row
 * listening for itself could not know that the same stroke is also the way back.
 */

import { createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import {
  commitsSlide,
  decideGesture,
  DOUBLE_TAP_MS,
  DOUBLE_TAP_PX,
  ROW_ACTIONS_PX,
  rowDrawer,
  rowStaysOpen,
  slideFollow,
} from "./gesture";
import type { GestureContext, GestureIntent } from "./gesture";

/** A screen that can be slid away to show the one below it (Workspace's note over its list). */
export interface BackStage {
  /** The screen the finger moves. */
  page: HTMLElement;
  /** What shows through under it, if the screen has it at hand. */
  under?: HTMLElement;
  /** Called once the slide has settled, either way; on `true` the screen goes back. */
  done: (commit: boolean) => void;
}

export interface GestureHooks {
  /** What the shell knows about the screen right now. */
  screen: () => { canGoBack: boolean; sheet: boolean };
  /** The screen with a level below it hands over what slides. Null: nothing to slide. */
  back: () => BackStage | null;
  /** The bar was pushed up: the note's sheet rises. */
  sheet: () => void;
  /** Two fingers tapped twice: the page alone, or the chrome back (85). */
  paper: () => void;
  /**
   * A wide window's two-finger trackpad strokes, read by the same rule: what one level out and
   * one level in would do right now (null: nothing), and the sheet that leans with the fingers.
   */
  wide: {
    active: () => boolean;
    out: () => (() => void) | null;
    cover: () => (() => void) | null;
    page: () => HTMLElement | null;
  };
}

/** Wheel events further apart than this belong to separate two-finger strokes. */
const WHEEL_GAP_MS = 180;

/** How far two fingers travel across a trackpad before a level goes or comes. */
const WHEEL_COMMIT_PX = 110;

/** How far the page leans with the fingers before it gives (a hint of the step, not the step). */
const WHEEL_LEAN_PX = 28;

/** Where a press must not start any of these: things with drags of their own. */
const OWN_DRAGS =
  "[data-corvu-drawer-content], .search, .palette-overlay, [role='dialog'], [data-no-gesture]";

const TEXT = "[contenteditable='true'], input, textarea, select";

/** The nearest box from `el` up that scrolls sideways and has somewhere to go. */
function sideScroller(el: Element | null, root: Element): { back: boolean; on: boolean } | null {
  for (let node = el; node && node !== root; node = node.parentElement) {
    if (node instanceof HTMLElement && node.scrollWidth > node.clientWidth + 1) {
      const overflow = getComputedStyle(node).overflowX;
      if (overflow === "auto" || overflow === "scroll") {
        return {
          back: node.scrollLeft > 0,
          on: node.scrollLeft + node.clientWidth < node.scrollWidth - 1,
        };
      }
    }
  }
  return null;
}

/**
 * What a stroke moves on a row: the actions it draws in over the row's end. The row itself
 * stays, so its start is still read while it is acted on (gesture.ts rowDrawer). Null until the
 * stroke has armed the row and they are mounted.
 */
function drawer(row: HTMLElement): HTMLElement | null {
  return row.querySelector<HTMLElement>("[data-swipe-actions]");
}

/** Stands a row's actions where a stroke that has come `travel` px puts them. */
function drawTo(row: HTMLElement, travel: number): void {
  const el = drawer(row);
  if (el) {
    el.style.transform = `translateX(${rowDrawer(travel)}px)`;
  }
}

/**
 * Said to a row when a stroke picks it (true) and once it has folded again (false). A row
 * mounts what lies behind it only between the two, so a list of years of lines keeps one row's
 * actions in the page, not one set per line (CLAUDE.md: keep the DOM small).
 */
const ARM_EVENT = "palm:arm";

function arm(row: HTMLElement, armed: boolean): void {
  row.dispatchEvent(new CustomEvent<boolean>(ARM_EVENT, { detail: armed }));
}

/**
 * A row's side of the arming: whether its actions are mounted, and the ref that listens for it.
 * The event arrives inside the stroke's handler, so the actions are in the page before the
 * stroke first draws them.
 */
export function createArmed(): [Accessor<boolean>, (row: HTMLElement) => void] {
  const [armed, setArmed] = createSignal(false);
  const ref = (row: HTMLElement): void => {
    row.addEventListener(ARM_EVENT, (e) => setArmed((e as CustomEvent<boolean>).detail));
  };
  return [armed, ref];
}

/**
 * Said by a control that has taken the finger for a drag of its own after it landed (the ring,
 * which opens on a press held still): whatever stroke the rule was still weighing ends here, so
 * the same finger is never also a back or a raised sheet.
 */
const CLAIM_EVENT = "palm:claim";

export function claimStroke(): void {
  globalThis.dispatchEvent(new CustomEvent(CLAIM_EVENT));
}

/** Plays a settle from where the finger left an element: a transition, then the styles go. */
function settle(el: HTMLElement, transform: string, then?: () => void): void {
  el.classList.add("palm-settling");
  // A frame so the transition sees the change, not the starting value
  requestAnimationFrame(() => {
    el.style.transform = transform;
  });
  let finished = false;
  const finish = (): void => {
    if (finished) {
      return;
    }
    finished = true;
    el.classList.remove("palm-settling");
    then?.();
  };
  el.addEventListener("transitionend", finish, { once: true });
  // A transition that never runs (reduced motion, a hidden element) sends no transitionend
  setTimeout(finish, 320);
}

/** Lets a row's actions settle in their place, open. */
function drawOpen(row: HTMLElement): void {
  const el = drawer(row);
  if (el) {
    settle(el, "translateX(0px)");
  }
}

interface Stroke {
  x: number;
  y: number;
  /** The last two samples, for the speed at release. */
  lastX: number;
  lastT: number;
  vx: number;
  context: GestureContext;
  intent: GestureIntent | "pending";
  row?: HTMLElement;
  /** Where an already open row stood when this stroke picked it up. */
  rowFrom: number;
  stage?: BackStage | null;
}

/** A two-finger tap: when and where, to pair with the next one. */
interface TwoTap {
  t: number;
  x: number;
  y: number;
}

/**
 * Wires the gestures onto `root` (the app). Returns the function that takes them off.
 */
export function attachGestures(root: HTMLElement, hooks: GestureHooks): () => void {
  let stroke: Stroke | null = null;
  /** The row standing open on its actions, if any. One at a time. */
  let openRow: HTMLElement | null = null;
  /** A press that only closed an open row must not also tap what was under it. */
  let swallowClick = false;
  let twoFinger: { t: number; x: number; y: number; moved: boolean } | null = null;
  let lastTwoTap: TwoTap | null = null;

  const closeRow = (row: HTMLElement): void => {
    delete row.dataset.swiped;
    const el = drawer(row);
    // Back off the row's end: what was drawn in can go
    const done = (): void => {
      if (row.dataset.swiped === undefined) {
        arm(row, false);
      }
    };
    if (el) {
      settle(el, `translateX(${ROW_ACTIONS_PX}px)`, done);
    } else {
      done();
    }
    if (openRow === row) {
      openRow = null;
    }
  };

  const contextAt = (target: Element, x: number): GestureContext => {
    const screen = hooks.screen();
    const row = target.closest<HTMLElement>("[data-swipe]");
    return {
      startX: x,
      canGoBack: screen.canGoBack,
      onRow: row !== null && target.closest("[data-swipe-actions]") === null,
      sideScroll: sideScroller(target, root),
      inText: target.closest(TEXT) !== null,
      onSheetBar: screen.sheet && target.closest(".place-switch") !== null,
    };
  };

  const onStart = (e: TouchEvent): void => {
    if (e.touches.length === 2) {
      const [a, b] = [e.touches.item(0), e.touches.item(1)];
      if (a && b) {
        twoFinger = {
          t: performance.now(),
          x: (a.clientX + b.clientX) / 2,
          y: (a.clientY + b.clientY) / 2,
          moved: false,
        };
      }
      // A second finger ends whatever the first one started; it never meant a slide
      stroke = null;
      return;
    }
    if (e.touches.length !== 1) {
      return;
    }
    const touch = e.touches.item(0);
    const target = e.target instanceof Element ? e.target : null;
    if (!touch || !target || target.closest(OWN_DRAGS)) {
      stroke = null;
      return;
    }
    const row = target.closest<HTMLElement>("[data-swipe]") ?? undefined;
    // Touching anywhere but an open row's actions folds it, and that touch does nothing else
    if (openRow && !(row === openRow && target.closest("[data-swipe-actions]"))) {
      const wasOpen = openRow;
      closeRow(wasOpen);
      if (row === wasOpen) {
        swallowClick = true;
      }
    }
    stroke = {
      x: touch.clientX,
      y: touch.clientY,
      lastX: touch.clientX,
      lastT: e.timeStamp,
      vx: 0,
      context: contextAt(target, touch.clientX),
      intent: "pending",
      row,
      rowFrom: 0,
    };
  };

  const follow = (s: Stroke, dx: number): void => {
    switch (s.intent) {
      case "back": {
        if (!s.stage) {
          return;
        }
        const width = globalThis.innerWidth;
        const x = slideFollow(dx, width);
        const progress = Math.min(1, x / width);
        s.stage.page.style.transform = `translateX(${x}px)`;
        if (s.stage.under) {
          // The screen below starts a quarter back and dimmed, and comes forward with the finger
          s.stage.under.style.transform = `translateX(${(progress - 1) * 25}%)`;
          s.stage.under.style.opacity = String(0.55 + progress * 0.45);
        }
        break;
      }
      case "row": {
        if (!s.row) {
          return;
        }
        drawTo(s.row, s.rowFrom + dx);
        break;
      }
      default: {
        break;
      }
    }
  };

  const begin = (s: Stroke): void => {
    if (s.intent === "back") {
      s.stage = hooks.back();
      if (!s.stage) {
        s.intent = "none";
        return;
      }
      s.stage.page.classList.add("palm-lifted");
      s.stage.under?.classList.add("palm-under");
    }
    if (s.intent === "row" && s.row) {
      if (s.row.dataset.swiped !== undefined) {
        s.rowFrom = -ROW_ACTIONS_PX;
      }
      // Another row standing open folds as this one starts
      if (openRow && openRow !== s.row) {
        closeRow(openRow);
      }
      arm(s.row, true);
    }
    if (s.intent === "sheet") {
      hooks.sheet();
    }
  };

  const onMove = (e: TouchEvent): void => {
    if (twoFinger && e.touches.length === 2) {
      const [a, b] = [e.touches.item(0), e.touches.item(1)];
      if (a && b) {
        const x = (a.clientX + b.clientX) / 2;
        const y = (a.clientY + b.clientY) / 2;
        if (Math.hypot(x - twoFinger.x, y - twoFinger.y) > DOUBLE_TAP_PX / 2) {
          twoFinger.moved = true;
        }
      }
      return;
    }
    const s = stroke;
    const touch = e.touches.item(0);
    if (!s || !touch || e.touches.length !== 1) {
      return;
    }
    const dx = touch.clientX - s.x;
    const dy = touch.clientY - s.y;
    const dt = Math.max(1, e.timeStamp - s.lastT);
    s.vx = (touch.clientX - s.lastX) / dt;
    s.lastX = touch.clientX;
    s.lastT = e.timeStamp;
    if (s.intent === "pending") {
      s.intent = decideGesture(s.context, dx, dy);
      if (s.intent === "pending") {
        return;
      }
      begin(s);
    }
    if (s.intent === "scroll" || s.intent === "none" || s.intent === "sheet") {
      return;
    }
    // Ours from here: the page must not scroll under a sideways slide
    if (e.cancelable) {
      e.preventDefault();
    }
    follow(s, dx);
  };

  const end = (s: Stroke, dx: number): void => {
    switch (s.intent) {
      case "back": {
        const { stage } = s;
        if (!stage) {
          return;
        }
        const through = commitsSlide({ distance: dx, velocity: s.vx }, globalThis.innerWidth);
        const clear = (): void => {
          stage.page.classList.remove("palm-lifted");
          stage.page.style.transform = "";
          if (stage.under) {
            stage.under.classList.remove("palm-under");
            stage.under.style.transform = "";
            stage.under.style.opacity = "";
          }
          stage.done(through);
        };
        if (stage.under) {
          stage.under.classList.add("palm-settling");
          requestAnimationFrame(() => {
            if (stage.under) {
              stage.under.style.transform = through ? "translateX(0%)" : "translateX(-25%)";
              stage.under.style.opacity = through ? "1" : "0.55";
            }
          });
          setTimeout(() => stage.under?.classList.remove("palm-settling"), 320);
        }
        settle(stage.page, through ? "translateX(100%)" : "translateX(0px)", clear);
        break;
      }
      case "row": {
        const { row } = s;
        if (!row) {
          return;
        }
        const travelled = -(s.rowFrom + dx);
        if (rowStaysOpen({ distance: travelled, velocity: -s.vx })) {
          row.dataset.swiped = "";
          openRow = row;
          drawOpen(row);
        } else {
          closeRow(row);
        }
        break;
      }
      default: {
        break;
      }
    }
  };

  const onEnd = (e: TouchEvent): void => {
    if (twoFinger && e.touches.length === 0) {
      const tap = twoFinger;
      twoFinger = null;
      const quick = performance.now() - tap.t < 300;
      if (quick && !tap.moved) {
        // The gap is from the first tap's lift to the second one's landing
        const near =
          lastTwoTap &&
          tap.t - lastTwoTap.t < DOUBLE_TAP_MS &&
          Math.hypot(tap.x - lastTwoTap.x, tap.y - lastTwoTap.y) < DOUBLE_TAP_PX;
        if (near) {
          lastTwoTap = null;
          hooks.paper();
        } else {
          lastTwoTap = { t: performance.now(), x: tap.x, y: tap.y };
        }
      }
      return;
    }
    const s = stroke;
    stroke = null;
    const touch = e.changedTouches.item(0);
    if (!s || !touch || s.intent === "pending") {
      return;
    }
    end(s, touch.clientX - s.x);
  };

  const onCancel = (): void => {
    const s = stroke;
    stroke = null;
    twoFinger = null;
    if (!s || s.intent === "pending") {
      return;
    }
    // Whatever was following the finger goes back where it was
    end(s, 0);
  };

  const onClick = (e: MouseEvent): void => {
    if (swallowClick) {
      swallowClick = false;
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // ---- a wide window: two fingers on a trackpad ----

  /**
   * One two-finger stroke, put together from the wheel events it sends. The fingers move the
   * other way from the scroll they ask for (deltaX > 0 scrolls right, so the fingers went left).
   * A stroke whose meaning has been settled keeps it until the events stop for a moment.
   */
  interface Swipe {
    dx: number;
    dy: number;
    last: number;
    intent: GestureIntent | "pending";
    target: Element;
    row?: HTMLElement;
    /** The page leaning with the fingers, and whether its step has already been taken. */
    page: HTMLElement | null;
    done: boolean;
  }
  let swipe: Swipe | null = null;
  let swipeEnd: ReturnType<typeof setTimeout> | undefined;

  /** The stroke has stopped: a leaning page settles, a row stays open or closes. */
  const finishSwipe = (): void => {
    const s = swipe;
    swipe = null;
    if (!s) {
      return;
    }
    if (s.page) {
      const { page } = s;
      settle(page, "translateX(0px)", () => {
        page.style.transform = "";
      });
    }
    if (s.intent === "row" && s.row) {
      const from = s.row.dataset.swiped === undefined ? 0 : -ROW_ACTIONS_PX;
      if (rowStaysOpen({ distance: -(from + s.dx), velocity: 0 })) {
        s.row.dataset.swiped = "";
        openRow = s.row;
        drawOpen(s.row);
      } else {
        closeRow(s.row);
      }
    }
  };

  const onWheel = (e: WheelEvent): void => {
    // A pinch is a zoom, and a phone has its fingers on the glass instead
    if (e.ctrlKey || !hooks.wide.active()) {
      return;
    }
    const now = e.timeStamp;
    if (!swipe || now - swipe.last > WHEEL_GAP_MS) {
      finishSwipe();
      const target = e.target instanceof Element ? e.target : null;
      if (!target || target.closest(OWN_DRAGS)) {
        return;
      }
      swipe = {
        dx: 0,
        dy: 0,
        last: now,
        intent: "pending",
        target,
        row: target.closest<HTMLElement>("[data-swipe]") ?? undefined,
        page: null,
        done: false,
      };
    }
    const s = swipe;
    s.last = now;
    // Lines, not pixels, from some mice: a line is about a row's height
    const scale = e.deltaMode === 1 ? 32 : 1;
    s.dx -= e.deltaX * scale;
    s.dy -= e.deltaY * scale;
    clearTimeout(swipeEnd);
    swipeEnd = setTimeout(finishSwipe, WHEEL_GAP_MS);
    if (s.intent === "pending") {
      const out = hooks.wide.out();
      const cover = hooks.wide.cover();
      s.intent = decideGesture(
        {
          // The edge is a finger's; two fingers can start anywhere
          startX: Number.POSITIVE_INFINITY,
          canGoBack: out !== null,
          onRow: s.row !== undefined && s.target.closest("[data-swipe-actions]") === null,
          sideScroll: sideScroller(s.target, root),
          inText: s.target.closest(TEXT) !== null,
          onSheetBar: false,
          canCover: cover !== null,
        },
        s.dx,
        s.dy,
      );
      if (s.intent === "row" && s.row) {
        if (openRow && openRow !== s.row) {
          closeRow(openRow);
        }
        arm(s.row, true);
      }
      if (s.intent === "back" || s.intent === "cover") {
        s.page = hooks.wide.page();
      }
    }
    if (s.intent !== "back" && s.intent !== "cover" && s.intent !== "row") {
      return;
    }
    // Ours: neither the page's own scroll nor the browser's history swipe takes it
    e.preventDefault();
    if (s.intent === "row" && s.row) {
      const from = s.row.dataset.swiped === undefined ? 0 : -ROW_ACTIONS_PX;
      drawTo(s.row, from + s.dx);
      return;
    }
    if (s.done) {
      return;
    }
    const lean = Math.max(-WHEEL_LEAN_PX, Math.min(WHEEL_LEAN_PX, s.dx * 0.25));
    if (s.page) {
      s.page.style.transform = `translateX(${lean}px)`;
    }
    if (Math.abs(s.dx) >= WHEEL_COMMIT_PX) {
      s.done = true;
      const step = s.intent === "back" ? hooks.wide.out() : hooks.wide.cover();
      step?.();
    }
  };

  // A control took the finger for its own drag: a stroke not yet decided is dropped, and one
  // already following goes back where it was
  const onClaim = (): void => {
    const s = stroke;
    stroke = null;
    if (s && s.intent !== "pending") {
      end(s, 0);
    }
  };
  globalThis.addEventListener(CLAIM_EVENT, onClaim);

  // Not passive: a slide that is ours stops the page scrolling under it
  root.addEventListener("touchstart", onStart, { passive: true });
  root.addEventListener("touchmove", onMove, { passive: false });
  root.addEventListener("touchend", onEnd, { passive: true });
  root.addEventListener("touchcancel", onCancel, { passive: true });
  root.addEventListener("click", onClick, { capture: true });
  root.addEventListener("wheel", onWheel, { passive: false });
  return () => {
    globalThis.removeEventListener(CLAIM_EVENT, onClaim);
    root.removeEventListener("touchstart", onStart);
    root.removeEventListener("touchmove", onMove);
    root.removeEventListener("touchend", onEnd);
    root.removeEventListener("touchcancel", onCancel);
    root.removeEventListener("click", onClick, { capture: true });
    root.removeEventListener("wheel", onWheel);
    clearTimeout(swipeEnd);
  };
}

/** Folds whatever row stands open: a tap on one of its actions has been answered. */
export function closeSwipedRows(): void {
  for (const row of document.querySelectorAll<HTMLElement>("[data-swipe][data-swiped]")) {
    delete row.dataset.swiped;
    arm(row, false);
  }
}
