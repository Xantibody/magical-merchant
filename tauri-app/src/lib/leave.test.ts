import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";
import { emit, TauriEvent } from "@tauri-apps/api/event";
import { createLeaveHandlers, watchLeave } from "./leave";

describe("createLeaveHandlers", () => {
  it("runs every registered handler and waits for all of them", async () => {
    const handlers = createLeaveHandlers();
    const order: string[] = [];
    handlers.register(async () => {
      await Promise.resolve();
      order.push("note");
    });
    handlers.register(() => {
      order.push("scrawl");
    });

    await handlers.run();

    expect(order.toSorted()).toStrictEqual(["note", "scrawl"]);
  });

  it("forgets a handler once its screen is gone", async () => {
    const handlers = createLeaveHandlers();
    let calls = 0;
    const off = handlers.register(() => {
      calls += 1;
    });
    off();

    await handlers.run();

    expect(calls).toBe(0);
  });

  // One screen's failed save must not stop the others from being written
  it("lets the other handlers finish when one throws", async () => {
    const handlers = createLeaveHandlers();
    let saved = false;
    handlers.register(() => {
      throw new Error("disk full");
    });
    handlers.register(() => {
      saved = true;
    });

    await handlers.run();

    expect(saved).toBe(true);
  });
});

describe("watchLeave", () => {
  let hidden: boolean;
  let leaves: number;
  let stop: () => void;

  beforeEach(async () => {
    hidden = false;
    leaves = 0;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (hidden ? "hidden" : "visible"),
    });
    mockWindows("main");
    mockIPC(() => null, { shouldMockEvents: true });
    stop = await watchLeave(() => {
      leaves += 1;
    });
  });

  afterEach(() => {
    stop();
    clearMocks();
    Reflect.deleteProperty(document, "visibilityState");
  });

  const goHidden = (): void => {
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
  };
  const comeBack = (): void => {
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  };

  // Android: the app goes to the background. The page is hidden and nothing else arrives
  it("fires when the page is hidden", () => {
    goHidden();

    expect(leaves).toBe(1);
  });

  // Desktop: another app takes the window. The page stays visible, only Tauri knows
  it("fires when the window loses focus", async () => {
    await emit(TauriEvent.WINDOW_BLUR);

    expect(leaves).toBe(1);
  });

  it("fires when the page is being unloaded", () => {
    globalThis.dispatchEvent(new Event("pagehide"));

    expect(leaves).toBe(1);
  });

  // Hiding the window on desktop sends both the blur and the hidden. One leave, not two
  it("counts one leave until the app has come back", async () => {
    await emit(TauriEvent.WINDOW_BLUR);
    goHidden();
    globalThis.dispatchEvent(new Event("pagehide"));
    expect(leaves).toBe(1);

    comeBack();
    await emit(TauriEvent.WINDOW_FOCUS);
    goHidden();

    expect(leaves).toBe(2);
  });

  it("ignores a visibility change that is not a hide", () => {
    comeBack();

    expect(leaves).toBe(0);
  });

  it("stops listening once stopped", async () => {
    stop();

    goHidden();
    await emit(TauriEvent.WINDOW_BLUR);

    expect(leaves).toBe(0);
  });
});
