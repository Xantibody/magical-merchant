import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import { createDebouncedAccessor } from "./debounce";

const DELAY = 200;

/**
 * effect は createRoot のコールバックが返るまで走らない。値の更新は
 * root の外から行わないと、購読前の変更として黙って落ちる。
 */
function setup(): {
  setSource: (value: string) => void;
  debounced: Accessor<string>;
  dispose: () => void;
} {
  const [source, setSource] = createSignal("a");
  let debounced!: Accessor<string>;
  const dispose = createRoot((d) => {
    debounced = createDebouncedAccessor(source, DELAY);
    return d;
  });
  return { setSource, debounced, dispose };
}

describe("createDebouncedAccessor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts with the source's current value", () => {
    const { debounced, dispose } = setup();

    expect(debounced()).toBe("a");
    dispose();
  });

  it("holds the old value until the delay passes", () => {
    const { setSource, debounced, dispose } = setup();

    setSource("ab");
    vi.advanceTimersByTime(DELAY - 1);

    expect(debounced()).toBe("a");
    dispose();
  });

  it("applies the newest value once typing pauses", () => {
    const { setSource, debounced, dispose } = setup();

    setSource("ab");
    vi.advanceTimersByTime(DELAY);

    expect(debounced()).toBe("ab");
    dispose();
  });

  // 1 打鍵ごとに発火しては debounce の意味がない。タイマーは打鍵で巻き戻る。
  it("collapses a burst of changes into one update", () => {
    const { setSource, debounced, dispose } = setup();

    setSource("ab");
    vi.advanceTimersByTime(DELAY - 50);
    setSource("abc");
    vi.advanceTimersByTime(DELAY - 50);
    setSource("abcd");

    expect(debounced()).toBe("a");
    vi.advanceTimersByTime(DELAY);
    expect(debounced()).toBe("abcd");
    dispose();
  });

  it("stops pending updates when the owner is disposed", () => {
    const { setSource, debounced, dispose } = setup();

    setSource("ab");
    dispose();
    vi.advanceTimersByTime(DELAY);

    expect(debounced()).toBe("a");
  });
});
