import { createSignal, For, onCleanup, Show } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import { Portal } from "solid-js/web";
import Icon from "./Icon";
import type { IconName } from "./Icon";
import { t } from "../lib/i18n";
import { MARK_PAD_PX, MARK_PX, PILL_PX, pastRing, petalAt, ringLayout } from "../lib/ring";
import type { Point, RingAnchor, RingChoice, RingLayout } from "../lib/ring";
import { claimStroke } from "../lib/palm-gestures";

/** Something under a slide that is not a choice but answers a release: a place on the pill. */
export interface RingPlace {
  id: string;
  label: string;
  run: () => void;
}

/** Where a carried + (or pencil) would land if let go here, and what that does (7). */
export interface DropTarget {
  label: string;
  /** A box drawn round what it lands on (a row). */
  box?: { left: number; top: number; width: number; height: number };
  /** A line drawn where it would be put (between two blocks of a page). */
  line?: { left: number; top: number; width: number };
  drop: () => void;
}

/** What a press carries once it has slid past the fan, or (with no choices) once it moves. */
interface RingCarry {
  icon: IconName;
  /** Said while nothing would take it. */
  label: string;
  targetAt: (x: number, y: number) => DropTarget | null;
}

interface RingPressOptions {
  choices: () => RingChoice[];
  /**
   * 0: the fan opens on the press itself (the +, whose only job is the fan). Otherwise the
   * press must be held still this long (the pill, whose tap goes to a place).
   */
  holdMs: number;
  /** A slide up off the control opens the fan at once, without waiting for the hold. */
  slideOpens?: boolean;
  /**
   * The control's own tap, for one whose tap must never be lost to the fan (send): a release
   * back over the control runs it, however long the press, instead of leaving the fan standing.
   */
  tap?: () => void;
  /** What the caption says while nothing is under the thumb. */
  hint?: (overControl: boolean) => string;
  /** What stays lit through the veil: the pressed control unless a whole bar should (the pill). */
  spot?: () => HTMLElement | undefined;
  /** The pill's places under a slide while the fan is up: release there for its list (93). */
  placeAt?: (x: number, y: number) => RingPlace | null;
  /** What the press carries past the fan (7). With no choices it is carried from the first move. */
  carry?: () => RingCarry | null;
}

/** The handlers a trigger spreads on itself, and its own click guard. */
interface RingHandlers {
  onPointerDown: (e: PointerEvent & { currentTarget: HTMLElement }) => void;
  onPointerMove: (e: PointerEvent) => void;
  onPointerUp: (e: PointerEvent) => void;
  onPointerCancel: () => void;
  onContextMenu: (e: MouseEvent) => void;
}

export interface RingPress {
  handlers: RingHandlers;
  /** False right after a press the fan took: the click that follows it is not a tap. */
  shouldClick: () => boolean;
  open: Accessor<boolean>;
  /** The place under a slide along the pill, lit there before it is let go on. */
  place: Accessor<RingPlace | null>;
  /** The fan itself, portalled over everything. Mount it once beside the trigger. */
  view: () => JSX.Element;
}

/** A finger may wander this far and still be holding still (Chrome's own slop is 8px). */
const SLOP_PX = 10;
/** A release this near the control still counts as on it: a thumb's pad, not a pointer's tip. */
const ON_CONTROL_PX = 8;

/**
 * Every fan standing open, by the way to fold it. Android's back folds the topmost layer, and
 * a fan left for a tap is one; the fans live in their own controls, so they report here.
 */
const openRings = new Set<() => void>();

/** Whether a fan stands open (for the system back's layers). */
export function ringStanding(): boolean {
  return openRings.size > 0;
}

/** Folds the fan standing open, if one is. */
export function foldRing(): void {
  for (const close of openRings) {
    close();
  }
}

function anchorOf(origin: Point, box?: DOMRect): RingAnchor {
  return { x: origin.x, top: box?.top ?? origin.y, bottom: box?.bottom ?? origin.y };
}

/**
 * The veil's hole over the control that was pressed, so the thumb still sees where it pressed
 * (and the × the + turned into, or the pill to slide along). A mask, not a z-index: the control
 * lives inside the page's own stacking contexts and cannot rise over a layer portalled to body.
 */
function veilHole(spot: DOMRect | undefined): JSX.CSSProperties {
  if (!spot) {
    return {};
  }
  const rx = (spot.width / 2) * Math.SQRT2 + 4;
  const ry = (spot.height / 2) * Math.SQRT2 + 4;
  const cx = spot.left + spot.width / 2;
  const cy = spot.top + spot.height / 2;
  const mask = `radial-gradient(ellipse ${rx}px ${ry}px at ${cx}px ${cy}px, transparent 82%, #000 100%)`;
  return { "mask-image": mask, "-webkit-mask-image": mask };
}

/** A pill's edge on its mark's side: the name runs from there into the screen. */
function pillEdge(layout: RingLayout, petal: Point): JSX.CSSProperties {
  const half = MARK_PX / 2 + MARK_PAD_PX;
  const top = `${petal.y - PILL_PX / 2}px`;
  if (layout.side === "left") {
    const width = document.documentElement.clientWidth || globalThis.innerWidth;
    return { top, right: `${width - (petal.x + half)}px` };
  }
  return { top, left: `${petal.x - half}px` };
}

/**
 * The reach's one menu (65, 68, 93 folded into a single gesture): a press on a control at the
 * foot opens a fan of labelled pills out of it, and the thumb slides onto one and lets go. A
 * press let go where it was pressed leaves the fan standing for a tap, over a scrim that takes
 * the next press for itself: a tap beside the fan only folds it, it never reaches the row under
 * it. Sliding along the pill instead reaches its places (their lists), and sliding on past the
 * fan carries what was pressed into the page, to be dropped where it should land (7).
 *
 * Pointer events with capture, not the palm's touch rule: the slide is the trigger's own drag,
 * and the mouse uses the same fan on a wide window. The moment the fan opens it claims the
 * stroke from the gesture rule, so the same finger is never also a back or a raised sheet.
 */
export function createRingPress(options: RingPressOptions): RingPress {
  const [ring, setRing] = createSignal<{
    origin: Point;
    layout: RingLayout;
    spot: DOMRect | undefined;
  } | null>(null);
  const [hover, setHover] = createSignal(-1);
  const [place, setPlace] = createSignal<RingPlace | null>(null);
  const [carried, setCarried] = createSignal<{
    at: Point;
    carry: RingCarry;
    target: DropTarget | null;
  } | null>(null);
  /** Let go where it was pressed: the fan stays for a second, tapped choice. */
  const [standing, setStanding] = createSignal(false);
  /** Whether the thumb is back over the control it pressed (what a release there would do). */
  const [overControl, setOverControl] = createSignal(true);
  let press: { id: number; start: Point; moved: boolean } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let took = false;
  /** The control the last press landed on: pressing it again folds a standing fan. */
  let trigger: HTMLElement | undefined;

  const ringless = (): boolean => options.choices().length === 0;

  const onControl = (at: Point): boolean => {
    const box = trigger?.getBoundingClientRect();
    return (
      box !== undefined &&
      at.x >= box.left - ON_CONTROL_PX &&
      at.x <= box.right + ON_CONTROL_PX &&
      at.y >= box.top - ON_CONTROL_PX &&
      at.y <= box.bottom + ON_CONTROL_PX
    );
  };

  const close = (): void => {
    openRings.delete(close);
    setRing(null);
    setHover(-1);
    setPlace(null);
    setCarried(null);
    setStanding(false);
  };

  const openAt = (origin: Point, box?: DOMRect): void => {
    const root = document.documentElement;
    const layout = ringLayout(anchorOf(origin, box), options.choices().length, {
      width: root.clientWidth || globalThis.innerWidth,
      height: root.clientHeight || globalThis.innerHeight,
    });
    setRing({ origin, layout, spot: (options.spot?.() ?? trigger)?.getBoundingClientRect() });
    openRings.add(close);
    setHover(-1);
    setPlace(null);
    setStanding(false);
    setOverControl(true);
    took = true;
    claimStroke();
    // A tick where the device has a motor: the hold has turned into the fan
    globalThis.navigator?.vibrate?.(8);
  };

  const choose = (index: number): void => {
    const choice = options.choices()[index];
    close();
    choice?.run();
  };

  const carryFrom = (at: Point): boolean => {
    const carry = options.carry?.();
    if (!carry) {
      return false;
    }
    setHover(-1);
    setPlace(null);
    setCarried({ at, carry, target: carry.targetAt(at.x, at.y) });
    return true;
  };

  /** What is under the finger now: a choice, a place, or (past the fan) a landing spot. */
  const track = (at: Point): void => {
    const open = ring();
    if (!open) {
      return;
    }
    const current = carried();
    if (current) {
      setCarried({ ...current, at, target: current.carry.targetAt(at.x, at.y) });
      return;
    }
    setOverControl(onControl(at));
    const index = petalAt(open.layout, at);
    setHover(index);
    const under = index === -1 ? (options.placeAt?.(at.x, at.y) ?? null) : null;
    setPlace(under);
    if (index === -1 && !under && pastRing(open.layout, at)) {
      carryFrom(at);
    }
  };

  const onKey = (e: KeyboardEvent): void => {
    if (ring() && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  globalThis.addEventListener("keydown", onKey, true);
  onCleanup(() => {
    globalThis.removeEventListener("keydown", onKey, true);
    clearTimeout(timer);
    openRings.delete(close);
  });

  const handlers: RingHandlers = {
    onPointerDown: (e) => {
      if (e.button !== 0) {
        return;
      }
      trigger = e.currentTarget;
      // The trigger pressed again while its fan stands folds it, and that press is spent
      if (ring() && standing()) {
        close();
        took = true;
        return;
      }
      took = false;
      press = { id: e.pointerId, start: { x: e.clientX, y: e.clientY }, moved: false };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // A pointer already gone cannot be captured; the moves over the trigger still arrive
      }
      if (ringless()) {
        return;
      }
      const box = e.currentTarget.getBoundingClientRect();
      if (options.holdMs <= 0) {
        openAt({ x: box.left + box.width / 2, y: box.top + box.height / 2 }, box);
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (press && !press.moved) {
          openAt(press.start, box);
        }
      }, options.holdMs);
    },
    onPointerMove: (e) => {
      if (!press || e.pointerId !== press.id) {
        return;
      }
      const at = { x: e.clientX, y: e.clientY };
      if (!press.moved && Math.hypot(at.x - press.start.x, at.y - press.start.y) > SLOP_PX) {
        press.moved = true;
        clearTimeout(timer);
        const box = trigger?.getBoundingClientRect();
        // Nothing to pick from: the press is a carry from its first real move
        if (ringless() && !ring()) {
          openAt(press.start, box);
          carryFrom(at);
        } else if (options.slideOpens && !ring() && at.y < press.start.y) {
          openAt(press.start, box);
        }
      }
      track(at);
    },
    onPointerUp: (e) => {
      clearTimeout(timer);
      const ended = press;
      press = null;
      if (!ended || !ring()) {
        return;
      }
      const at = { x: e.clientX, y: e.clientY };
      const current = carried();
      if (current) {
        close();
        current.target?.drop();
        return;
      }
      const index = hover();
      if (index !== -1) {
        choose(index);
        return;
      }
      // A control whose tap is never lost: let go back on it, it does what a tap does. The
      // click after this press is still swallowed (took), so it runs once
      if (options.tap && (!ended.moved || onControl(at))) {
        close();
        options.tap();
        return;
      }
      // Let go where it was pressed: the fan stays for a tapped choice. Before the places, or
      // the button held down would read as its own list
      if (!ended.moved) {
        setStanding(true);
        return;
      }
      const under = place();
      if (under) {
        close();
        under.run();
        return;
      }
      close();
    },
    onPointerCancel: () => {
      clearTimeout(timer);
      press = null;
      if (!standing()) {
        close();
      }
    },
    // A held finger is a context menu to the WebView; the fan is this press's answer
    onContextMenu: (e) => e.preventDefault(),
  };

  const caption = (): string => {
    const current = carried();
    if (current) {
      return current.target?.label ?? current.carry.label;
    }
    const under = place();
    if (under) {
      return under.label;
    }
    const index = hover();
    if (index !== -1) {
      return options.choices()[index]?.label ?? "";
    }
    // Standing, the fan is tapped, not slid: it says so, and how to put it away
    if (standing()) {
      return t().reach.ringTap;
    }
    return options.hint?.(overControl()) ?? t().reach.ringHint;
  };

  const view = (): JSX.Element => (
    <Show when={ring()}>
      {(open) => (
        <Portal>
          <div
            class="ring-layer"
            classList={{
              "ring-layer--carrying": carried() !== null,
              "ring-layer--standing": standing(),
            }}
            role="menu"
            aria-label={t().reach.ring}
            data-no-gesture
          >
            {/* Standing, the scrim takes the press beside the fan for itself, and that press
                only folds it. The click, not the pointerdown, folds it, so the press, the
                release and the click all land here and nothing under it hears any of them. Its
                mousedown keeps the focus where it was: a field under it keeps its keyboard */}
            <button
              type="button"
              class="ring-scrim"
              style={veilHole(open().spot)}
              tabIndex={-1}
              aria-label={t().common.close}
              onMouseDown={(e) => e.preventDefault()}
              onClick={close}
            />
            <span class="ring-caption" aria-live="polite">
              {caption()}
            </span>
            <Show when={!carried()}>
              <For each={options.choices()}>
                {(choice, i) => {
                  const petal = (): Point => open().layout.petals[i()] ?? open().origin;
                  return (
                    <button
                      type="button"
                      role="menuitem"
                      class="ring-petal"
                      classList={{
                        "ring-petal--hover": hover() === i(),
                        "ring-petal--left": open().layout.side === "left",
                      }}
                      style={{
                        ...pillEdge(open().layout, petal()),
                        "--from-x": `${open().origin.x - petal().x}px`,
                        "--from-y": `${open().origin.y - petal().y}px`,
                        "animation-delay": `${i() * 24}ms`,
                      }}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choose(i())}
                    >
                      <span class="ring-petal-mark" aria-hidden="true">
                        <Icon name={choice.icon} size={18} />
                      </span>
                      <span class="ring-petal-name">{choice.label}</span>
                    </button>
                  );
                }}
              </For>
            </Show>
            <Show when={carried()}>
              {(current) => (
                <>
                  <Show when={current().target?.box}>
                    {(box) => (
                      <span
                        class="ring-drop-box"
                        style={{
                          left: `${box().left}px`,
                          top: `${box().top}px`,
                          width: `${box().width}px`,
                          height: `${box().height}px`,
                        }}
                        aria-hidden="true"
                      />
                    )}
                  </Show>
                  <Show when={current().target?.line}>
                    {(line) => (
                      <span
                        class="ring-drop-line"
                        style={{
                          left: `${line().left}px`,
                          top: `${line().top}px`,
                          width: `${line().width}px`,
                        }}
                        aria-hidden="true"
                      />
                    )}
                  </Show>
                  <span
                    class="ring-carried"
                    style={{ left: `${current().at.x}px`, top: `${current().at.y}px` }}
                    aria-hidden="true"
                  >
                    <Icon name={current().carry.icon} size={22} />
                  </span>
                </>
              )}
            </Show>
          </div>
        </Portal>
      )}
    </Show>
  );

  return {
    handlers,
    shouldClick: () => {
      const tap = !took;
      took = false;
      return tap;
    },
    open: () => ring() !== null,
    place,
    view,
  };
}
