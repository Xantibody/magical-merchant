import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@solidjs/testing-library";
import SheetGrip from "./SheetGrip";

interface Spies {
  onToggle: () => void;
  onCover: () => void;
  onOut: () => void;
}

function spies(): Spies {
  return {
    onToggle: vi.fn<() => void>(),
    onCover: vi.fn<() => void>(),
    onOut: vi.fn<() => void>(),
  };
}

function grip(open: boolean, on: Spies): HTMLElement {
  render(() => <SheetGrip label="一覧をしまう" open={open} {...on} />);
  return screen.getByRole("button", { name: "一覧をしまう" });
}

/** A mouse drag across the grip, as the pointer events arrive. */
function drag(el: HTMLElement, dx: number): void {
  fireEvent.pointerDown(el, { pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(el, { pointerId: 1, clientX: 100 + dx / 2, clientY: 100 });
  fireEvent.pointerMove(el, { pointerId: 1, clientX: 100 + dx, clientY: 100 });
  fireEvent.pointerUp(el, { pointerId: 1, clientX: 100 + dx, clientY: 100 });
  fireEvent.click(el);
}

describe("SheetGrip", () => {
  afterEach(cleanup);

  it("moves the level beside the page on a click", () => {
    const on = spies();
    fireEvent.click(grip(true, on));

    expect(on.onToggle).toHaveBeenCalledTimes(1);
    expect(on.onCover).not.toHaveBeenCalled();
  });

  it("covers once when dragged left, however far it goes, and is no click", () => {
    const on = spies();
    drag(grip(true, on), -120);

    expect(on.onCover).toHaveBeenCalledTimes(1);
    expect(on.onToggle).not.toHaveBeenCalled();
    expect(on.onOut).not.toHaveBeenCalled();
  });

  it("uncovers when dragged right, whichever way the level beside stands", () => {
    const on = spies();
    drag(grip(true, on), 120);

    expect(on.onOut).toHaveBeenCalledTimes(1);
    expect(on.onCover).not.toHaveBeenCalled();
  });

  it("does nothing for a drag too short to mean a side", () => {
    const on = spies();
    const el = grip(true, on);
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 80, clientY: 100 });

    expect(on.onCover).not.toHaveBeenCalled();
  });

  it("says which way it stands", () => {
    expect(grip(false, spies()).getAttribute("aria-expanded")).toBe("false");
  });
});
