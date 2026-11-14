/**
 * When the chrome slims while reading (4, 58, 63). Reading down a list or a note, the bar at the
 * foot gives the page its room back: the places and the action fold into one thin line that
 * says the state in words. Turning back up, even a little, is the sign of looking for
 * something, and the bar returns. Near the top it is always whole: nothing is being read yet.
 *
 * The turn is measured from the farthest point reached in the current direction, so a page
 * that settles a pixel or two after a fling (momentum, a re-layout) does not flicker the bar.
 *
 * "Down" and "the top" are a page's; a list built from the foot (lib/foot.ts) is read upward
 * from its foot, and the same steps run on its depth from there.
 */

import { hiddenAbove, scrollDepth } from "./foot";

export interface SlimState {
  slim: boolean;
  /** The scroll position the current direction started from, or reached farthest. */
  turn: number;
  /** The last position seen, to tell the direction of the next one. */
  last: number;
}

export const WHOLE: SlimState = { slim: false, turn: 0, last: 0 };

/** Within this much of the top the bar is whole whatever the direction. */
const NEAR_TOP_PX = 56;
/** Reading down this far past the turn slims it. */
const DOWN_PX = 40;
/** Coming back up this far restores it: less than going down, so looking up is answered at once. */
const UP_PX = 16;

export function slimStep(state: SlimState, top: number): SlimState {
  if (top <= NEAR_TOP_PX) {
    return { slim: false, turn: top, last: top };
  }
  const down = top > state.last;
  const wasDown = state.last >= state.turn;
  // A change of direction moves the turn to where it happened
  const turn = down === wasDown ? state.turn : state.last;
  if (down && top - turn > DOWN_PX) {
    return { slim: true, turn, last: top };
  }
  if (!down && turn - top > UP_PX) {
    return { slim: false, turn, last: top };
  }
  return { slim: state.slim, turn, last: top };
}

/**
 * Follows every vertical scroller under `root` at once (a scroll event does not bubble, but it
 * can be caught on the way down), keeps a state per scroller and reports the one that moved.
 * It also marks a scroller that has left its top (`data-scrolled`), which is what fades the
 * page into the veil above it (palm.css) instead of a rule.
 */
export function watchSlim(root: HTMLElement, onSlim: (slim: boolean) => void): () => void {
  const states = new WeakMap<Element, SlimState>();
  const onScroll = (e: Event): void => {
    const el = e.target;
    // Sideways rows of chips scroll too; only a page read downward slims anything
    if (!(el instanceof HTMLElement) || el.scrollHeight <= el.clientHeight + 1) {
      return;
    }
    // A list built from the foot is read upward from its foot, a page downward from its top:
    // either way the depth is how far from where it rests (lib/foot.ts)
    const next = slimStep(states.get(el) ?? WHOLE, scrollDepth(el));
    states.set(el, next);
    el.toggleAttribute("data-scrolled", hiddenAbove(el));
    // Said on every event, not only on a change: the shell resets it on a move between
    // screens, and a list that kept its own state would never say it again
    onSlim(next.slim);
  };
  root.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => root.removeEventListener("scroll", onScroll, { capture: true });
}
