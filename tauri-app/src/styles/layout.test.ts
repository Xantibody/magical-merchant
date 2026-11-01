import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { page } from "vitest/browser";

/**
 * The overlap with the Android system bars was not visible until a real device was used.
 * The real sizes are collected into `--safe-top` / `--safe-bottom`, so values can be
 * injected here to check that the layout fits inside the screen.
 */
const ANDROID_SAFE_TOP = "42px";
const ANDROID_SAFE_BOTTOM = "24px";

function setInsets(top: string, bottom: string): void {
  document.documentElement.style.setProperty("--safe-top", top);
  document.documentElement.style.setProperty("--safe-bottom", bottom);
}

function element(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) {
    throw new Error(`expected ${selector} to be mounted`);
  }
  return found;
}

function mountApp(): HTMLElement {
  document.body.innerHTML = `
    <div class="app">
      <div class="app-column">
        <header class="mobile-header">header</header>
        <main class="app-main"><div class="view"></div></main>
        <div class="status-dot-area">
          <div class="status-dot-links"></div>
          <button class="status-dot"><span class="status-dot-mark"></span></button>
        </div>
      </div>
    </div>`;
  const app = document.querySelector<HTMLElement>(".app");
  if (!app) {
    throw new Error("expected .app to be mounted");
  }
  return app;
}

describe("app shell inside the system bars", () => {
  beforeAll(async () => {
    await import("../index.css");
  });

  afterEach(() => {
    document.documentElement.style.removeProperty("--safe-top");
    document.documentElement.style.removeProperty("--safe-bottom");
    document.body.innerHTML = "";
  });

  // html carries the safe-area padding, so leaving .app at 100dvh pushes its bottom edge
  // off screen and sends the input bar behind the navigation bar
  it("does not overflow the viewport when the system bars take space", () => {
    setInsets(ANDROID_SAFE_TOP, ANDROID_SAFE_BOTTOM);
    const app = mountApp();

    const { bottom } = app.getBoundingClientRect();

    expect(bottom).toBeLessThanOrEqual(globalThis.innerHeight + 0.5);
  });

  it("uses the whole viewport when there are no system bars", () => {
    setInsets("0px", "0px");
    const app = mountApp();

    expect(app.getBoundingClientRect().height).toBeCloseTo(globalThis.innerHeight, 0);
  });
});

function mountAction(): HTMLElement {
  document.body.innerHTML = `<button class="icon-button" data-hint-key="⌘N"></button>`;
  return element("[data-hint-key]");
}

/** The badge is a pseudo-element, so whether it shows can only be read from content. */
function badge(target: HTMLElement): string {
  return getComputedStyle(target, "::after").content;
}

describe("the shell on a wide window", () => {
  beforeAll(async () => {
    await import("../index.css");
    await page.viewport(1280, 800);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("leaves no header above the body on a wide window", () => {
    mountApp();

    expect(getComputedStyle(element(".mobile-header")).display).toBe("none");
  });

  // The body keeps the whole height: the dot floats, it takes no row (ADR 0011)
  it("gives the body the window's foot and floats the dot in the corner", () => {
    mountApp();

    const dot = element(".status-dot").getBoundingClientRect();
    const main = element(".app-main").getBoundingClientRect();

    expect(main.bottom).toBeCloseTo(globalThis.innerHeight, 0);
    expect(globalThis.innerWidth - dot.right).toBeCloseTo(12, 0);
    expect(globalThis.innerHeight - dot.bottom).toBeCloseTo(12, 0);
  });

  // While hidden, the links' box must not steal presses from whatever lies under it
  it("keeps the hidden links out of reach of the pointer", () => {
    mountApp();

    expect(getComputedStyle(element(".status-dot-area")).pointerEvents).toBe("none");
    expect(getComputedStyle(element(".status-dot-links")).opacity).toBe("0");
    expect(getComputedStyle(element(".status-dot")).pointerEvents).toBe("auto");
  });

  it("draws the mark in each tone", () => {
    mountApp();
    const button = element(".status-dot");
    // The tone fades in; computed style would still read the one before it
    element(".status-dot-mark").style.transition = "none";
    const color = (tone: string): string => {
      button.dataset.tone = tone;
      return getComputedStyle(element(".status-dot-mark")).backgroundColor;
    };

    expect(new Set([color("ok"), color("busy"), color("failed")]).size).toBe(3);
  });
});

describe("the shell on a phone", () => {
  beforeAll(async () => {
    await import("../index.css");
  });

  afterEach(async () => {
    document.body.innerHTML = "";
    await page.viewport(1280, 800);
  });

  it("keeps a header, and takes the dot into it", async () => {
    await page.viewport(390, 800);
    mountApp();

    expect(getComputedStyle(element(".mobile-header")).display).toBe("flex");
    // The corner has the capture dock. The dot is in the header instead
    expect(getComputedStyle(element(".status-dot-area")).display).toBe("none");
  });
});

describe("what floats over the app", () => {
  beforeAll(async () => {
    await import("../index.css");
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  // Menus, the palette, pages and the restore button all enter with one movement. If the
  // palette appeared like something that had been there all along, pressing ⌘K and what
  // came up would not connect
  it("rises the palette like every other thing that floats", () => {
    document.body.innerHTML = `<div class="palette-overlay"><div class="palette"></div></div>`;

    const style = getComputedStyle(element(".palette"));

    expect(style.animationName).toBe("mm-rise");
    expect(style.animationDuration).toBe("0.18s");
  });
});

describe("the hint layer", () => {
  beforeAll(async () => {
    await import("../index.css");
  });

  afterEach(() => {
    delete document.documentElement.dataset.hints;
    document.body.innerHTML = "";
  });

  it("draws nothing until the modifier is being held", () => {
    const action = mountAction();

    expect(badge(action)).toBe("none");
  });

  // The badge is a pseudo-element. Not one DOM node is added while it is showing
  it("prints the key from the attribute while the modifier is held", () => {
    const action = mountAction();

    document.documentElement.dataset.hints = "";

    expect(badge(action)).toBe('"⌘N"');
    expect(action.childElementCount).toBe(0);
  });

  /**
   * The collections of the component library (Kobalte) write a row's internal identifier
   * into `data-key`. Menu, list, tab and accordion, four families, all do the same, so
   * excluding by role is not enough: the badge reads only our own attribute name.
   */
  it("draws no badge for the identifier a component library writes", () => {
    document.body.innerHTML = `<div role="menuitem" data-key="item-3">削除</div>
      <div role="option" data-key="hit-7">ノート</div>`;

    document.documentElement.dataset.hints = "";

    expect(badge(element('[role="menuitem"]'))).toBe("none");
    expect(badge(element('[role="option"]'))).toBe("none");
  });
});

/**
 * Only one status popover hangs off the column of surfaces. There are two entry points, the
 * corner dot (wide window) and the band (narrow window), but both open the same popover.
 *
 * The base that hangs it under the header (`.popover-anchor { top: 100% }`) cannot be used
 * here. This column is the full height of the window, so straight below it is off screen
 * and the `overflow: hidden` on `.app` cuts it away. Pressing it would change only the
 * state and show nothing.
 */
function mountSyncPopover(): HTMLElement {
  document.body.innerHTML = `
    <div class="app">
      <div class="app-column">
        <header class="mobile-header">header</header>
        <main class="app-main"><div class="view"></div></main>
        <div class="popover-anchor popover-anchor--sync">
          <div class="popover" style="width: 260px; height: 180px;">sync</div>
        </div>
      </div>
    </div>`;
  return element(".popover");
}

describe("the sync panel", () => {
  beforeAll(async () => {
    await import("../index.css");
  });

  afterEach(async () => {
    document.body.innerHTML = "";
    await page.viewport(1280, 800);
  });

  it("opens straight above the corner dot on a wide window", async () => {
    await page.viewport(1280, 800);
    const rect = mountSyncPopover().getBoundingClientRect();

    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeCloseTo(760, 0);
    expect(rect.right).toBeCloseTo(1268, 0);
  });

  it("opens under the band on a phone", async () => {
    await page.viewport(390, 800);
    const rect = mountSyncPopover().getBoundingClientRect();

    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(800);
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(390);
  });
});
