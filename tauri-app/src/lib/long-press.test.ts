import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLongPress } from "./long-press";

const HOLD_MS = 500;

function touchDown(): { pointerType: string } {
  return { pointerType: "touch" };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createLongPress", () => {
  it("fires after the hold duration on touch", () => {
    const fired = vi.fn<() => void>();
    const press = createLongPress(fired, HOLD_MS);

    press.onPointerDown(touchDown());
    vi.advanceTimersByTime(HOLD_MS);

    expect(fired).toHaveBeenCalledTimes(1);
  });

  // PC の長押しに意味はない。マウスにはホバーのボタンがある
  it("ignores mouse presses", () => {
    const fired = vi.fn<() => void>();
    const press = createLongPress(fired, HOLD_MS);

    press.onPointerDown({ pointerType: "mouse" });
    vi.advanceTimersByTime(HOLD_MS);

    expect(fired).not.toHaveBeenCalled();
  });

  it("does not fire when released early", () => {
    const fired = vi.fn<() => void>();
    const press = createLongPress(fired, HOLD_MS);

    press.onPointerDown(touchDown());
    vi.advanceTimersByTime(HOLD_MS - 1);
    press.onPointerUp();
    vi.advanceTimersByTime(HOLD_MS);

    expect(fired).not.toHaveBeenCalled();
  });

  // 指が動いた=スクロール。押しっぱなしとは区別する
  it("cancels when the pointer moves", () => {
    const fired = vi.fn<() => void>();
    const press = createLongPress(fired, HOLD_MS);

    press.onPointerDown(touchDown());
    press.onPointerMove();
    vi.advanceTimersByTime(HOLD_MS);

    expect(fired).not.toHaveBeenCalled();
  });

  // 長押し後に指を離すと click が飛ぶ。それを編集開始に流さない
  it("swallows exactly the click that follows a long press", () => {
    const press = createLongPress(vi.fn<() => void>(), HOLD_MS);

    press.onPointerDown(touchDown());
    vi.advanceTimersByTime(HOLD_MS);
    press.onPointerUp();

    expect(press.shouldClick()).toBe(false);
    expect(press.shouldClick()).toBe(true);
  });

  it("lets an ordinary tap click through", () => {
    const press = createLongPress(vi.fn<() => void>(), HOLD_MS);

    press.onPointerDown(touchDown());
    vi.advanceTimersByTime(100);
    press.onPointerUp();

    expect(press.shouldClick()).toBe(true);
  });
});
