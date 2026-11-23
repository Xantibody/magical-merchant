/**
 * The DOM layer of the gestures, pinned as it stands: real TouchEvents and WheelEvents on a
 * plain div, hooks that only record. The rule itself is `gesture.test.ts`; this file is what
 * `attachGestures` does with its answers, and stays once the decisions move out to pure
 * functions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { attachGestures, claimStroke } from "./palm-gestures";
import type { BackStage, GestureHooks } from "./palm-gestures";

interface Fakes {
  hooks: GestureHooks;
  paper: ReturnType<typeof vi.fn<() => void>>;
  back: ReturnType<typeof vi.fn<() => BackStage | null>>;
  done: ReturnType<typeof vi.fn<(commit: boolean) => void>>;
  outStep: ReturnType<typeof vi.fn<() => void>>;
  page: HTMLElement;
}

let root: HTMLElement;
let detach: (() => void) | undefined;

function fakes(options: { canGoBack?: boolean; wide?: boolean } = {}): Fakes {
  const page = document.createElement("div");
  root.append(page);
  const done = vi.fn<(commit: boolean) => void>();
  const back = vi.fn<() => BackStage | null>(() => ({ page, done }));
  const paper = vi.fn<() => void>();
  const outStep = vi.fn<() => void>();
  const hooks: GestureHooks = {
    screen: () => ({ canGoBack: options.canGoBack ?? false, sheet: false }),
    back,
    sheet: vi.fn<() => void>(),
    paper,
    wide: {
      active: () => options.wide ?? false,
      out: () => outStep,
      cover: () => null,
      page: () => page,
    },
  };
  return { hooks, paper, back, done, outStep, page };
}

function attach(f: Fakes): void {
  detach = attachGestures(root, f.hooks);
}

function touchAt(target: Element, x: number, y: number, identifier = 0): Touch {
  return new Touch({ identifier, target, clientX: x, clientY: y });
}

function fire(
  target: Element,
  type: "touchstart" | "touchmove" | "touchend",
  touches: Touch[],
  changed: Touch[] = touches,
): void {
  target.dispatchEvent(
    new TouchEvent(type, { touches, changedTouches: changed, bubbles: true, cancelable: true }),
  );
}

/**
 * One finger from `fromX` to each x in `path`, then lifted at the last one. The last sample is
 * repeated so the speed at release is zero and only the distance decides.
 */
function stroke(target: Element, fromX: number, path: number[]): void {
  const y = 200;
  fire(target, "touchstart", [touchAt(target, fromX, y)]);
  for (const x of path) {
    fire(target, "touchmove", [touchAt(target, x, y)]);
  }
  const last = path.at(-1) ?? fromX;
  fire(target, "touchmove", [touchAt(target, last, y)]);
  fire(target, "touchend", [], [touchAt(target, last, y)]);
}

function twoFingerTap(target: Element): void {
  const a = touchAt(target, 100, 200, 0);
  const b = touchAt(target, 140, 200, 1);
  fire(target, "touchstart", [a, b]);
  fire(target, "touchend", [], [a, b]);
}

function wheel(target: Element, deltaX: number, init: WheelEventInit = {}): void {
  target.dispatchEvent(
    new WheelEvent("wheel", { deltaX, deltaY: 0, bubbles: true, cancelable: true, ...init }),
  );
}

/** A fresh root in the page for each test. */
function mountRoot(): void {
  localStorage.clear();
  root = document.createElement("div");
  document.body.append(root);
}

/** The gestures come off and the root leaves the page. */
function unmountRoot(): void {
  detach?.();
  detach = undefined;
  root.remove();
}

describe("palm-gestures › 2 本指で 2 回叩く", () => {
  beforeEach(mountRoot);
  afterEach(unmountRoot);

  it("calls paper once on the second two-finger tap, not on the first", () => {
    const f = fakes();
    attach(f);

    twoFingerTap(root);
    expect(f.paper).not.toHaveBeenCalled();

    twoFingerTap(root);
    expect(f.paper).toHaveBeenCalledTimes(1);
  });
});

describe("palm-gestures › 右へ払って戻る", () => {
  beforeEach(mountRoot);
  afterEach(unmountRoot);

  it("settles a long stroke from the edge with done(true)", async () => {
    const f = fakes({ canGoBack: true });
    attach(f);

    stroke(root, 5, [25, 5 + globalThis.innerWidth * 0.6]);

    expect(f.back).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(f.done).toHaveBeenCalledWith(true));
    expect(f.done).toHaveBeenCalledTimes(1);
    expect(f.page.classList.contains("palm-lifted")).toBe(false);
    expect(f.page.style.transform).toBe("");
  });

  it("springs a short stroke back with done(false)", async () => {
    const f = fakes({ canGoBack: true });
    attach(f);

    stroke(root, 5, [25, 45]);

    expect(f.back).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(f.done).toHaveBeenCalledWith(false));
    expect(f.done).toHaveBeenCalledTimes(1);
  });

  it("asks for no stage when the screen cannot go back", () => {
    const f = fakes({ canGoBack: false });
    attach(f);

    stroke(root, 5, [25, 5 + globalThis.innerWidth * 0.6]);

    expect(f.back).not.toHaveBeenCalled();
  });
});

describe("palm-gestures › 行を左へ払う", () => {
  beforeEach(mountRoot);
  afterEach(unmountRoot);

  it("leaves the row swiped and tells it palm:arm true", () => {
    const f = fakes();
    attach(f);
    const row = document.createElement("div");
    row.dataset.swipe = "";
    const label = document.createElement("span");
    label.textContent = "row";
    row.append(label);
    root.append(row);
    const armed: boolean[] = [];
    row.addEventListener("palm:arm", (e) => armed.push((e as CustomEvent<boolean>).detail));

    stroke(label, 300, [280, 150]);

    expect(row.dataset.swiped).toBe("");
    expect(armed).toStrictEqual([true]);
  });
});

describe("palm-gestures › claimStroke", () => {
  beforeEach(mountRoot);
  afterEach(unmountRoot);

  it("drops a stroke that is still undecided when a control claims the finger", () => {
    const f = fakes({ canGoBack: true });
    attach(f);
    const y = 200;
    const end = 5 + globalThis.innerWidth * 0.6;

    fire(root, "touchstart", [touchAt(root, 5, y)]);
    claimStroke();
    fire(root, "touchmove", [touchAt(root, 25, y)]);
    fire(root, "touchmove", [touchAt(root, end, y)]);
    fire(root, "touchend", [], [touchAt(root, end, y)]);

    expect(f.back).not.toHaveBeenCalled();
    expect(f.done).not.toHaveBeenCalled();
  });

  it("sends a stroke already following the finger back with done(false)", async () => {
    const f = fakes({ canGoBack: true });
    attach(f);
    const y = 200;

    fire(root, "touchstart", [touchAt(root, 5, y)]);
    fire(root, "touchmove", [touchAt(root, 5 + globalThis.innerWidth * 0.6, y)]);
    claimStroke();

    await vi.waitFor(() => expect(f.done).toHaveBeenCalledWith(false));
    expect(f.done).toHaveBeenCalledTimes(1);
  });

  // A claim is about the finger already down; one sent before a press does not carry over
  it("does not touch a stroke that lands after the claim", async () => {
    const f = fakes({ canGoBack: true });
    attach(f);

    claimStroke();
    stroke(root, 5, [25, 5 + globalThis.innerWidth * 0.6]);

    await vi.waitFor(() => expect(f.done).toHaveBeenCalledWith(true));
  });
});

describe("palm-gestures › トラックパッドの横移動", () => {
  beforeEach(mountRoot);
  afterEach(unmountRoot);

  it("runs wide.out()'s step once when two fingers have come 110px", () => {
    const f = fakes({ wide: true });
    attach(f);

    wheel(root, -30);
    wheel(root, -30);
    wheel(root, -30);
    expect(f.outStep).not.toHaveBeenCalled();

    wheel(root, -30);
    wheel(root, -30);
    wheel(root, -30);
    expect(f.outStep).toHaveBeenCalledTimes(1);
  });

  it("does nothing short of 110px", () => {
    const f = fakes({ wide: true });
    attach(f);

    wheel(root, -30);
    wheel(root, -30);
    wheel(root, -30);

    expect(f.outStep).not.toHaveBeenCalled();
  });

  it("does nothing while the window is not wide", () => {
    const f = fakes({ wide: false });
    attach(f);

    for (let i = 0; i < 6; i++) {
      wheel(root, -30);
    }

    expect(f.outStep).not.toHaveBeenCalled();
  });

  it("does nothing for a pinch (ctrlKey)", () => {
    const f = fakes({ wide: true });
    attach(f);

    for (let i = 0; i < 6; i++) {
      wheel(root, -30, { ctrlKey: true });
    }

    expect(f.outStep).not.toHaveBeenCalled();
  });

  it("does nothing over [data-no-gesture]", () => {
    const f = fakes({ wide: true });
    attach(f);
    const own = document.createElement("div");
    own.dataset.noGesture = "";
    root.append(own);

    for (let i = 0; i < 6; i++) {
      wheel(own, -30);
    }

    expect(f.outStep).not.toHaveBeenCalled();
  });
});
