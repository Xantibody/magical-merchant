import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import { createDebouncedAccessor } from "./debounce";

const DELAY = 200;

/**
 * An effect does not run until the createRoot callback returns. Unless the value is updated
 * from outside the root, the change is dropped silently as one made before subscription.
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

  // Firing on every keystroke would defeat the debounce. A keystroke rewinds the timer.
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
