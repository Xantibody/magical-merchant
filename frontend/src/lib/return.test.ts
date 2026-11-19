import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";
import { emit, TauriEvent } from "@tauri-apps/api/event";
import { watchReturn } from "./return";

describe("watchReturn", () => {
  let hidden: boolean;
  let returns: number;
  let stop: () => void;

  beforeEach(async () => {
    hidden = false;
    returns = 0;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (hidden ? "hidden" : "visible"),
    });
    mockWindows("main");
    mockIPC(() => null, { shouldMockEvents: true });
    stop = await watchReturn(() => {
      returns += 1;
    });
  });

  afterEach(() => {
    stop();
    clearMocks();
    Reflect.deleteProperty(document, "visibilityState");
  });

  const visibility = (isHidden: boolean): void => {
    hidden = isHidden;
    document.dispatchEvent(new Event("visibilitychange"));
  };

  // Android: the app comes back from the background. The page is visible again and nothing else arrives
  it("fires when the page becomes visible", () => {
    visibility(true);
    visibility(false);

    expect(returns).toBe(1);
  });

  // Desktop: the window takes focus back. The page never stopped being visible, only Tauri knows
  it("fires when the window regains focus", async () => {
    await emit(TauriEvent.WINDOW_FOCUS);

    expect(returns).toBe(1);
  });

  it("ignores the page being hidden", () => {
    visibility(true);

    expect(returns).toBe(0);
  });

  it("stops listening once stopped", async () => {
    stop();

    visibility(false);
    await emit(TauriEvent.WINDOW_FOCUS);

    expect(returns).toBe(0);
  });
});
