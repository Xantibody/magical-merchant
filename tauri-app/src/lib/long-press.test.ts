import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLongPress } from "./long-press";

const HOLD_MS = 500;

function touchDown(x = 100, y = 100): { pointerType: string; clientX: number; clientY: number } {
  return { pointerType: "touch", clientX: x, clientY: y };
}

function moveTo(x: number, y: number): { clientX: number; clientY: number } {
  return { clientX: x, clientY: y };
}

describe("createLongPress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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

    press.onPointerDown({ pointerType: "mouse", clientX: 100, clientY: 100 });
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

  // 置いたままの指は数 px 揺れ続ける。1 回の pointermove で捨てると、
  // 実機の長押しは 500ms を完走できない(#253)
  it("holds on through the jitter of a finger that is only resting", () => {
    const fired = vi.fn<() => void>();
    const press = createLongPress(fired, HOLD_MS);

    press.onPointerDown(touchDown(100, 100));
    press.onPointerMove(moveTo(103, 102));
    press.onPointerMove(moveTo(98, 104));
    vi.advanceTimersByTime(HOLD_MS);

    expect(fired).toHaveBeenCalledTimes(1);
  });

  // 指が動いた=スクロール。押しっぱなしとは区別する
  it("cancels once the finger has travelled further than a slip", () => {
    const fired = vi.fn<() => void>();
    const press = createLongPress(fired, HOLD_MS);

    press.onPointerDown(touchDown(100, 100));
    press.onPointerMove(moveTo(120, 100));
    vi.advanceTimersByTime(HOLD_MS);

    expect(fired).not.toHaveBeenCalled();
  });

  // 揺れの許容は押すたびに測り直す。少しずつ流れた指で 2 回目が固まらない
  it("measures the slip from the point the finger landed at", () => {
    const fired = vi.fn<() => void>();
    const press = createLongPress(fired, HOLD_MS);

    press.onPointerDown(touchDown(100, 100));
    press.onPointerMove(moveTo(120, 100));
    press.onPointerUp();
    press.onPointerDown(touchDown(120, 100));
    press.onPointerMove(moveTo(123, 100));
    vi.advanceTimersByTime(HOLD_MS);

    expect(fired).toHaveBeenCalledTimes(1);
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

  // 押しっぱなしは WebView から見るとテキスト選択の始まり。放っておくと
  // 「コピー」のメニューが長押しの手応えに割り込む
  it("keeps the platform context menu from opening", () => {
    const press = createLongPress(vi.fn<() => void>(), HOLD_MS);
    const preventDefault = vi.fn<() => void>();

    press.onContextMenu({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("lets an ordinary tap click through", () => {
    const press = createLongPress(vi.fn<() => void>(), HOLD_MS);

    press.onPointerDown(touchDown());
    vi.advanceTimersByTime(100);
    press.onPointerUp();

    expect(press.shouldClick()).toBe(true);
  });
});
