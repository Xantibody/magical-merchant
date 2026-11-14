import { createSignal, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";

/** The width from which the rail of places stands beside the page and the pill gives way to it. */
const WIDE_QUERY = "(min-width: 768px)";

/** Whether `query` matches, followed as the window is resized. */
function createMedia(query: string): Accessor<boolean> {
  const media = globalThis.matchMedia(query);
  const [matches, setMatches] = createSignal(media.matches);
  const onChange = (e: MediaQueryListEvent): void => {
    setMatches(e.matches);
  };
  media.addEventListener("change", onChange);
  onCleanup(() => media.removeEventListener("change", onChange));
  return matches;
}

/**
 * Whether the window is wide, followed as it is resized. The chrome mounts a different shape
 * per width (the rail or the pill, a sheet's own field or the pill's), not only a different
 * style: a hidden copy would still read the data and hold a draft of its own.
 */
export function createWide(): Accessor<boolean> {
  return createMedia(WIDE_QUERY);
}
