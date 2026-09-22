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
      <nav class="rail"></nav>
      <div class="app-column">
        <header class="mobile-header">header</header>
        <main class="app-main"><div class="view"></div></main>
        <div class="bottom-bar"></div>
        <nav class="bottom-tabs"><a class="bottom-tab">Notes</a></nav>
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
  // off screen and sends the bottom tabs and the input bar behind the navigation bar
  it("does not overflow the viewport when the system bars take space", () => {
    setInsets(ANDROID_SAFE_TOP, ANDROID_SAFE_BOTTOM);
    const app = mountApp();

    const { bottom } = app.getBoundingClientRect();

    expect(bottom).toBeLessThanOrEqual(globalThis.innerHeight + 0.5);
  });

  it("keeps the bottom tabs reachable above the navigation bar", () => {
    setInsets(ANDROID_SAFE_TOP, ANDROID_SAFE_BOTTOM);
    mountApp();
    const tabs = element(".bottom-tabs");
    // The bottom tabs show only at mobile widths. Look at the position alone, whatever
    // width the test runs at
    tabs.style.display = "flex";

    const { bottom } = tabs.getBoundingClientRect();
    const navigationBarTop = globalThis.innerHeight - Number.parseInt(ANDROID_SAFE_BOTTOM, 10);

    expect(bottom).toBeLessThanOrEqual(navigationBarTop + 0.5);
  });

  it("uses the whole viewport when there are no system bars", () => {
    setInsets("0px", "0px");
    const app = mountApp();

    expect(app.getBoundingClientRect().height).toBeCloseTo(globalThis.innerHeight, 0);
  });
});

/** The rail, and the current-location line sliding down its left edge. The view decides `top` and passes it through style. */
function mountRail(markerTop: number, off = false): void {
  document.body.innerHTML = `
    <div class="app">
      <nav class="rail">
        <a class="rail-button rail-button--active"></a>
        <a class="rail-button"></a>
        <span class="rail-marker" style="top:${markerTop}px" ${off ? "data-off" : ""}></span>
        <span class="rail-divider"></span>
        <button class="rail-button rail-button--plain"></button>
      </nav>
      <div class="app-column"><main class="app-main"></main></div>
    </div>`;
}

function mountAction(): HTMLElement {
  document.body.innerHTML = `<button class="icon-button" data-hint-key="⌘N"></button>`;
  return element("[data-hint-key]");
}

/** The badge is a pseudo-element, so whether it shows can only be read from content. */
function badge(target: HTMLElement): string {
  return getComputedStyle(target, "::after").content;
}

describe("the rail tells you where you are", () => {
  beforeAll(async () => {
    await import("../index.css");
    await page.viewport(1280, 800);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("is a 48px column with a hairline down its right edge", () => {
    mountRail(18);

    const rail = element(".rail");
    const style = getComputedStyle(rail);

    expect(rail.getBoundingClientRect().width).toBeCloseTo(48, 0);
    expect(style.borderRightWidth).toBe("1px");
  });

  // There are no words, so the current location is said with a fill. The header tabs showed
  // it with font weight alone, but a rail entry is only one icon
  it("fills the button you are on and leaves the others bare", () => {
    mountRail(18);

    const active = getComputedStyle(element(".rail-button--active"));
    const idle = getComputedStyle(element(".rail-button:not(.rail-button--active)"));

    expect(active.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(idle.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  });

  // The line slides between the three surfaces. The surface decides the position; the
  // smoothness lives here
  it("slides the marker with a transition on top alone", () => {
    mountRail(58);

    const marker = element(".rail-marker");
    const style = getComputedStyle(marker);
    const rail = element(".rail").getBoundingClientRect();

    expect(marker.getBoundingClientRect().top - rail.top).toBeCloseTo(58, 0);
    expect(marker.getBoundingClientRect().width).toBeCloseTo(2, 0);
    expect(marker.getBoundingClientRect().height).toBeCloseTo(20, 0);
    expect(style.transitionProperty).toContain("top");
    expect(style.transitionDuration).toContain("0.22s");
  });

  // While Settings is open the line is not shown. It is not a surface, so there is nowhere
  // to slide it to
  it("hides the marker where there is no mode to point at", () => {
    mountRail(58, true);

    expect(getComputedStyle(element(".rail-marker")).opacity).toBe("0");
  });

  it("leaves no header above the body on a wide window", () => {
    mountApp();

    expect(getComputedStyle(element(".mobile-header")).display).toBe("none");
  });

  it("puts a 30px bar under the body", () => {
    mountApp();

    const bar = element(".bottom-bar");

    expect(bar.getBoundingClientRect().height).toBeCloseTo(30, 0);
    expect(getComputedStyle(bar).borderTopWidth).toBe("1px");
  });

  // The bottom tabs belong to mobile. On a wide window the bands would stack two deep
  it("keeps the bottom tabs off a wide window", () => {
    mountApp();

    expect(getComputedStyle(element(".bottom-tabs")).display).toBe("none");
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

  it("swaps the rail for a header and the bottom tabs", async () => {
    await page.viewport(390, 800);
    mountApp();

    expect(getComputedStyle(element(".rail")).display).toBe("none");
    expect(getComputedStyle(element(".mobile-header")).display).toBe("flex");
    expect(getComputedStyle(element(".bottom-tabs")).display).toBe("flex");
    expect(getComputedStyle(element(".bottom-bar")).display).toBe("none");
  });

  // `body.md-toolbar-open .bottom-tabs`, which folds the bottom tabs away while the
  // keyboard is up, belongs to the formatting bar's CSS and sits inside
  // `@media (hover: none)`. Headless Chromium has hover, so it cannot be tried from here:
  // check it on a real device
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
 * Only one sync popover hangs off the column of surfaces. There are two entry points, the
 * rail (wide window) and the band (narrow window), but both open the same popover.
 *
 * The base that hangs it under the header (`.popover-anchor { top: 100% }`) cannot be used
 * here. This column is the full height of the window, so straight below it is off screen
 * and the `overflow: hidden` on `.app` cuts it away. Pressing it would change only the
 * state and show nothing.
 */
function mountSyncPopover(): HTMLElement {
  document.body.innerHTML = `
    <div class="app">
      <nav class="rail"></nav>
      <div class="app-column">
        <header class="mobile-header">header</header>
        <main class="app-main"><div class="view"></div></main>
        <div class="popover-anchor popover-anchor--sync">
          <div class="popover" style="width: 260px; height: 180px;">sync</div>
        </div>
        <nav class="bottom-tabs"><a class="bottom-tab">Notes</a></nav>
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

  it("opens beside the rail's foot on a wide window", async () => {
    await page.viewport(1280, 800);
    const rect = mountSyncPopover().getBoundingClientRect();

    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(800);
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(1280);
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
