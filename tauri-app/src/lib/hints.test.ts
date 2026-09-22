import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot } from "solid-js";
import { HINT_HOLD_MS, createHints } from "./hints";

function press(key: string, init: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, ...init });
}

/** createHints uses onCleanup. Do not create it where it has no owner */
function withHints(enabled: boolean, run: (hints: ReturnType<typeof createHints>) => void): void {
  createRoot((dispose) => {
    run(createHints(enabled));
    dispose();
  });
}

describe("createHints", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays hidden until the modifier has been held long enough", () => {
    withHints(true, (hints) => {
      hints.keyDown(press("Meta"));
      expect(hints.visible()).toBe(false);

      vi.advanceTimersByTime(HINT_HOLD_MS - 1);
      expect(hints.visible()).toBe(false);

      vi.advanceTimersByTime(1);
      expect(hints.visible()).toBe(true);
    });
  });

  it("accepts Control as the modifier too", () => {
    withHints(true, (hints) => {
      hints.keyDown(press("Control"));
      vi.advanceTimersByTime(HINT_HOLD_MS);

      expect(hints.visible()).toBe(true);
    });
  });

  // Someone who typed ⌘N wants to make a note, not to look at the badges
  it("gives up as soon as the held modifier turns into a shortcut", () => {
    withHints(true, (hints) => {
      hints.keyDown(press("Meta"));
      hints.keyDown(press("n", { metaKey: true }));
      vi.advanceTimersByTime(HINT_HOLD_MS * 2);

      expect(hints.visible()).toBe(false);
    });
  });

  it("takes the hints back down while they are showing", () => {
    withHints(true, (hints) => {
      hints.keyDown(press("Meta"));
      vi.advanceTimersByTime(HINT_HOLD_MS);

      hints.hide();

      expect(hints.visible()).toBe(false);
    });
  });

  // In some environments holding the modifier delivers keydown over and over. Restarting
  // the count each time means the badges never appear however long it is held
  it("does not restart the wait on a repeated keydown", () => {
    withHints(true, (hints) => {
      hints.keyDown(press("Meta"));
      vi.advanceTimersByTime(HINT_HOLD_MS - 50);
      hints.keyDown(press("Meta", { repeat: true }));
      vi.advanceTimersByTime(50);

      expect(hints.visible()).toBe(true);
    });
  });

  // The badge says "⌘⇧S". If it vanished the moment that ⇧ was pressed, it could not be
  // pressed as read
  it("stays up while Shift joins the held modifier", () => {
    withHints(true, (hints) => {
      hints.keyDown(press("Meta"));
      vi.advanceTimersByTime(HINT_HOLD_MS);

      hints.keyDown(press("Shift", { metaKey: true, shiftKey: true }));
      expect(hints.visible()).toBe(true);

      hints.keyUp(press("Shift", { metaKey: true }));
      expect(hints.visible()).toBe(true);

      hints.keyUp(press("Meta"));
      expect(hints.visible()).toBe(false);
    });
  });

  // A touch-only device has no modifier key, and nowhere to show them
  it("never shows anything where there is no hover", () => {
    withHints(false, (hints) => {
      hints.keyDown(press("Meta"));
      vi.advanceTimersByTime(HINT_HOLD_MS * 2);

      expect(hints.visible()).toBe(false);
    });
  });
});
