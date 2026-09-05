import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot } from "solid-js";
import { HINT_HOLD_MS, createHints } from "./hints";

function press(key: string, init: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, ...init });
}

/** createHints は onCleanup を使う。持ち主のいない場所で作らない */
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

  // ⌘N を打った人は札を見たいのではなく、ノートを作りたい
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

  // 修飾キーを押し続けると keydown が繰り返し届く環境がある。
  // そのたびに数え直すと、押し続けているのに札がいつまでも出ない
  it("does not restart the wait on a repeated keydown", () => {
    withHints(true, (hints) => {
      hints.keyDown(press("Meta"));
      vi.advanceTimersByTime(HINT_HOLD_MS - 50);
      hints.keyDown(press("Meta", { repeat: true }));
      vi.advanceTimersByTime(50);

      expect(hints.visible()).toBe(true);
    });
  });

  // 札には「⌘⇧S」と書いてある。その ⇧ を押した瞬間に札が消えては、
  // 読んだ通りに押せない
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

  // タッチしかない端末に修飾キーは無い。出す先も無い
  it("never shows anything where there is no hover", () => {
    withHints(false, (hints) => {
      hints.keyDown(press("Meta"));
      vi.advanceTimersByTime(HINT_HOLD_MS * 2);

      expect(hints.visible()).toBe(false);
    });
  });
});
