import { createSignal, createEffect, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";

/**
 * Return an Accessor that catches up delayMs after source stops changing.
 * Used as the source of a createResource, it gathers up reads that cannot afford to be
 * issued on every keystroke, such as a search.
 */
export function createDebouncedAccessor<T>(source: Accessor<T>, delayMs: number): Accessor<T> {
  const [value, setValue] = createSignal(source());
  let timer: ReturnType<typeof setTimeout> | undefined;

  createEffect(() => {
    const next = source();
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => setValue(() => next), delayMs);
  });

  onCleanup(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });

  return value;
}
