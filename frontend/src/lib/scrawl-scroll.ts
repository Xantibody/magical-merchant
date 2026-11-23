/**
 * Whether the list has been scrolled far enough from the newest records to offer the way back.
 * Newest first, so the newest sit at the top: once three quarters of a screen has gone by they
 * are out of sight, and finding them again is a long fling. Closer than that, they are a short
 * flick away and a button would only cover the rows.
 */
export function awayFromNewest(scrollTop: number, viewportHeight: number): boolean {
  return scrollTop > viewportHeight * 0.75;
}
