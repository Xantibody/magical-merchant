import { cleanup, render } from "@solidjs/testing-library";
import { page } from "vitest/browser";
import { afterEach, describe, it, expect } from "vitest";
import ActionBar from "./ActionBar";

afterEach(() => cleanup());

function makeTouch(target: Element, clientY: number): Touch {
  return new Touch({ identifier: 0, target, clientY, clientX: 0 });
}

function flick(target: Element, startY: number, endY: number) {
  target.dispatchEvent(
    new TouchEvent("touchstart", {
      bubbles: true,
      touches: [makeTouch(target, startY)],
    }),
  );
  target.dispatchEvent(
    new TouchEvent("touchend", {
      bubbles: true,
      changedTouches: [makeTouch(target, endY)],
    }),
  );
}

function tap(target: Element, clientY = 0) {
  target.dispatchEvent(
    new TouchEvent("touchstart", {
      bubbles: true,
      touches: [makeTouch(target, clientY)],
    }),
  );
  target.dispatchEvent(
    new TouchEvent("touchend", {
      bubbles: true,
      changedTouches: [makeTouch(target, clientY)],
    }),
  );
}

describe("ActionBar", () => {
  it("renders children", async () => {
    const { baseElement } = render(() => (
      <ActionBar>
        <button>Test Action</button>
      </ActionBar>
    ));
    const screen = page.elementLocator(baseElement);

    await expect.element(screen.getByText("Test Action")).toBeInTheDocument();
  });

  it("has action-bar-zone and action-bar classes", async () => {
    const { baseElement } = render(() => (
      <ActionBar>
        <span>content</span>
      </ActionBar>
    ));

    expect(baseElement.querySelector(".action-bar-zone")).not.toBeNull();
    expect(baseElement.querySelector(".action-bar")).not.toBeNull();
  });

  describe("flick gesture", () => {
    it("adds visible class on upward flick", () => {
      const { baseElement } = render(() => (
        <ActionBar>
          <button>Action</button>
        </ActionBar>
      ));
      const zone = baseElement.querySelector(".action-bar-zone")!;
      const bar = baseElement.querySelector(".action-bar")!;

      flick(zone, 300, 250); // upward: deltaY = -50

      expect(bar.classList.contains("action-bar--visible")).toBe(true);
    });

    it("removes visible class on downward flick", () => {
      const { baseElement } = render(() => (
        <ActionBar>
          <button>Action</button>
        </ActionBar>
      ));
      const zone = baseElement.querySelector(".action-bar-zone")!;
      const bar = baseElement.querySelector(".action-bar")!;

      // First show it
      flick(zone, 300, 250);
      expect(bar.classList.contains("action-bar--visible")).toBe(true);

      // Then hide it
      flick(zone, 250, 300); // downward: deltaY = +50

      expect(bar.classList.contains("action-bar--visible")).toBe(false);
    });

    it("does not react to movement below threshold", () => {
      const { baseElement } = render(() => (
        <ActionBar>
          <button>Action</button>
        </ActionBar>
      ));
      const zone = baseElement.querySelector(".action-bar-zone")!;
      const bar = baseElement.querySelector(".action-bar")!;

      flick(zone, 300, 290); // deltaY = -10, below 30px threshold

      expect(bar.classList.contains("action-bar--visible")).toBe(false);
    });

    it("hides on tap outside the action bar", () => {
      const { baseElement } = render(() => (
        <ActionBar>
          <button>Action</button>
        </ActionBar>
      ));
      const zone = baseElement.querySelector(".action-bar-zone")!;
      const bar = baseElement.querySelector(".action-bar")!;

      // Show it first
      flick(zone, 300, 250);
      expect(bar.classList.contains("action-bar--visible")).toBe(true);

      // Tap outside (on document body, not on the bar)
      tap(document.body);

      expect(bar.classList.contains("action-bar--visible")).toBe(false);
    });

    it("does not hide on tap inside the action bar", () => {
      const { baseElement } = render(() => (
        <ActionBar>
          <button>Action</button>
        </ActionBar>
      ));
      const zone = baseElement.querySelector(".action-bar-zone")!;
      const bar = baseElement.querySelector(".action-bar")!;

      // Show it first
      flick(zone, 300, 250);
      expect(bar.classList.contains("action-bar--visible")).toBe(true);

      // Tap inside the bar
      const button = bar.querySelector("button")!;
      tap(button);

      expect(bar.classList.contains("action-bar--visible")).toBe(true);
    });
  });
});
