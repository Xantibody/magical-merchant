/**
 * Lists built from the foot (the reach). A list hangs from the bottom of its page and grows
 * upward: the newest record is the one nearest the thumb, the page's name and its search field
 * sit under it, and the top half of the glass is left for reading. Read upward, the older
 * records come down into reach. Scrawl is not one of them: it reads newest first from the top.
 *
 * The scroller is a `column-reverse` flex box holding one child in reading order (`[data-foot]`
 * in reach.css). The reverse anchors it: it opens at its foot, a list shorter than the glass
 * rests on the foot rather than the top, and rows loaded above (older ones) never push what is
 * in view. Its `scrollTop` is 0 at the foot and negative upward; `scrollDepth` turns that into
 * how far the reader has gone from where the list rests, so the slimming bar reads every
 * scroller the same way.
 */

/** The groups and their items turned so the newest stands at the foot, nearest the thumb. */
export function fromTheFoot<T>(
  groups: readonly { label: string; items: readonly T[] }[],
): { label: string; items: T[] }[] {
  return groups.toReversed().map(({ label, items }) => ({ label, items: items.toReversed() }));
}

/** Whether a scroller is one of these: it is marked in the markup, so no style is read. */
function isFootScroll(el: Element): boolean {
  return el instanceof HTMLElement && el.dataset.foot !== undefined;
}

/**
 * How far a scroller has been read from where it rests: from the top for a page read downward,
 * from the foot for a list built from it. Never negative.
 */
export function scrollDepth(el: HTMLElement): number {
  return Math.max(0, isFootScroll(el) ? -el.scrollTop : el.scrollTop);
}

/** Whether anything lies beyond the scroller's top edge (what the fade into the top says). */
export function hiddenAbove(el: HTMLElement): boolean {
  if (isFootScroll(el)) {
    return el.scrollHeight - el.clientHeight - scrollDepth(el) > 2;
  }
  return el.scrollTop > 2;
}
