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

  // A long press means nothing on desktop. A mouse has the button that appears on hover
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

  // A finger left resting keeps jittering by a few px. Giving up on a single pointermove
  // would stop a long press on a real device from reaching 500ms (#253)
  it("holds on through the jitter of a finger that is only resting", () => {
    const fired = vi.fn<() => void>();
    const press = createLongPress(fired, HOLD_MS);

    press.onPointerDown(touchDown(100, 100));
    press.onPointerMove(moveTo(103, 102));
    press.onPointerMove(moveTo(98, 104));
    vi.advanceTimersByTime(HOLD_MS);

    expect(fired).toHaveBeenCalledTimes(1);
  });

  // A finger that moved is a scroll. It is kept apart from a held press
  it("cancels once the finger has travelled further than a slip", () => {
    const fired = vi.fn<() => void>();
    const press = createLongPress(fired, HOLD_MS);

    press.onPointerDown(touchDown(100, 100));
    press.onPointerMove(moveTo(120, 100));
    vi.advanceTimersByTime(HOLD_MS);

    expect(fired).not.toHaveBeenCalled();
  });

  // The jitter allowance is measured afresh on every press, so a finger that drifted a
  // little does not lock up the second attempt
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

  // Lifting the finger after a long press fires a click. That click must not reach the
  // start of editing
  it("swallows exactly the click that follows a long press", () => {
    const press = createLongPress(vi.fn<() => void>(), HOLD_MS);

    press.onPointerDown(touchDown());
    vi.advanceTimersByTime(HOLD_MS);
    press.onPointerUp();

    expect(press.shouldClick()).toBe(false);
    expect(press.shouldClick()).toBe(true);
  });

  // Some devices emit no click after contextmenu has been preventDefault'ed. Leaving the
  // swallow flag set would take the next tap down with it
  it("lets the next tap through when no click followed the long press", () => {
    const press = createLongPress(vi.fn<() => void>(), HOLD_MS);

    press.onPointerDown(touchDown());
    vi.advanceTimersByTime(HOLD_MS);
    press.onPointerUp();

    press.onPointerDown(touchDown());
    vi.advanceTimersByTime(100);
    press.onPointerUp();

    expect(press.shouldClick()).toBe(true);
  });

  // To the WebView a held press is the start of a text selection. Left alone, the copy menu
  // cuts in on the feedback of the long press
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
