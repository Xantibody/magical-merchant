import { createSignal, createEffect, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";

/**
 * source の変化が止まってから delayMs 後に追いつく Accessor を返す。
 * 検索のように「1 打鍵ごとに発行してはコストが払えない」読み取りを、
 * これを createResource の source にすることでまとめる。
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
