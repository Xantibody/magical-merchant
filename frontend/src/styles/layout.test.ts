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

function mountShell(inner: string): HTMLElement {
  document.body.innerHTML = `<div class="app">${inner}</div>`;
  return element(".app");
}

/** The shell as AppLayout builds it on a wide window: the rail of places, then the page. */
function mountWide(): HTMLElement {
  return mountShell(`
      <nav class="library">
        <div class="library-top">
          <button class="status-line" data-tone="ok"><span class="status-dot-mark"></span><span class="status-line-text">保存しました</span></button>
        </div>
        <div class="library-foot">
          <button class="library-row"><span class="icon"></span><span class="library-row-label">Note</span></button>
        </div>
      </nav>
      <div class="app-column">
        <main class="app-main"><div class="view"></div></main>
      </div>
      <button class="compose-fab"></button>`);
}

/**
 * The shell on a phone. It mounts another shape, not a hidden copy of the wide one: no rail,
 * the state's dot in the corner, the place pill and the compose button at the foot.
 */
function mountPhone(): HTMLElement {
  return mountShell(`
      <div class="app-column">
        <main class="app-main"><div class="view"></div>
          <div class="palm-dot"><button class="status-dot"><span class="status-dot-mark"></span></button></div>
        </main>
      </div>
      <div class="place-switch">
        <span class="place-switch-ground"></span>
        <nav class="place-switch-places">
          <button class="place-switch-button"></button>
          <button class="place-switch-button"></button>
          <button class="place-switch-button"></button>
        </nav>
        <div class="place-switch-slot"></div>
      </div>
      <button class="compose-fab"></button>`);
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
    const app = mountPhone();

    const { bottom } = app.getBoundingClientRect();

    expect(bottom).toBeLessThanOrEqual(globalThis.innerHeight + 0.5);
  });

  it("uses the whole viewport when there are no system bars", () => {
    setInsets("0px", "0px");
    const app = mountPhone();

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

  afterEach(async () => {
    document.body.innerHTML = "";
    await page.viewport(1280, 800);
  });

  // The first pane: the rail of places stands at the left edge, 64px at every wide width, and
  // the body keeps the rest of the window, its foot included (R1, R6). The body is a sheet
  // lying on the rail's ground, so a strip of the ground shows round it
  it.each([
    [1280, 800],
    [1024, 768],
  ])(
    "stands the rail at the left edge and gives the body the rest (%i wide)",
    async (width, height) => {
      await page.viewport(width, height);
      mountWide();

      const library = element(".library").getBoundingClientRect();
      const main = element(".app-main").getBoundingClientRect();

      expect(library.left).toBeCloseTo(0, 0);
      expect(library.width).toBeCloseTo(64, 0);
      expect(main.left).toBeCloseTo(64 + 14, 0);
      expect(main.bottom).toBeCloseTo(globalThis.innerHeight - 10, 0);
    },
  );

  // The places are icons a finger's size; a name is a hover or a focus away
  it("keeps the rail's names for hover or focus", () => {
    mountWide();

    expect(element(".library-row").getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    expect(getComputedStyle(element(".library-row-label")).opacity).toBe("0");
    expect(getComputedStyle(element(".status-line-text")).opacity).toBe("0");
  });

  // The compose button is a phone's; a wide window writes on the line and with "+ new"
  it("shows no compose button", () => {
    mountWide();

    expect(getComputedStyle(element(".compose-fab")).display).toBe("none");
  });

  it("draws the mark in each tone", () => {
    mountWide();
    const button = element(".status-line");
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

  // No bar to reach up for: the page starts at the top edge, and only the state's dot is there
  it("keeps no bar over the page, only the dot in the corner", async () => {
    await page.viewport(390, 800);
    mountPhone();

    expect(element(".app-main").getBoundingClientRect().top).toBeCloseTo(0, 0);
    const dot = element(".palm-dot").getBoundingClientRect();
    expect(dot.right).toBeGreaterThan(370);
    expect(dot.top).toBeLessThan(8);
  });

  // R2: the main action is low on the right, where a thumb rests, and big enough for it
  it("puts the compose button in the lower right, a thumb's size", async () => {
    await page.viewport(390, 800);
    mountPhone();

    const fab = element(".compose-fab").getBoundingClientRect();

    expect(fab.width).toBeGreaterThanOrEqual(44);
    expect(fab.height).toBeGreaterThanOrEqual(44);
    expect(390 - fab.right).toBeCloseTo(16, 0);
    expect(fab.top).toBeGreaterThan(800 * (2 / 3));
  });

  // R1, R2: Scrawl, Note and Codex are one tap apart, low on the left opposite the compose
  // button, each button a finger's size and clear of it
  it("puts the place switch in the lower left, a finger's size, clear of the compose button", async () => {
    await page.viewport(390, 800);
    mountPhone();

    const bar = element(".place-switch").getBoundingClientRect();
    const fab = element(".compose-fab").getBoundingClientRect();
    const buttons = [...document.querySelectorAll<HTMLElement>(".place-switch-button")].map(
      (button) => button.getBoundingClientRect(),
    );

    expect(bar.left).toBeCloseTo(16, 0);
    expect(bar.top).toBeGreaterThan(800 * (2 / 3));
    expect(bar.right).toBeLessThan(fab.left);
    for (const button of buttons) {
      expect(button.width).toBeGreaterThanOrEqual(44);
      expect(button.height).toBeGreaterThanOrEqual(44);
    }
  });

  // A control keeps its place from one screen to the next: the pill a thumb found on a list is
  // under the same thumb on a note. The way back a level brings in stands after the pill, in
  // the room between it and the page's own buttons, so it moves nothing
  it("keeps the place pill where it was on a level, with the way back after it", async () => {
    await page.viewport(390, 800);
    const app = mountPhone();
    const onList = element(".place-switch").getBoundingClientRect();

    app.insertAdjacentHTML(
      "beforeend",
      `<button class="palm-out"></button>
       <div class="palm-actions">
         <button class="palm-action-more"></button>
         <button class="compose-fab"></button>
       </div>`,
    );
    const bar = element(".place-switch").getBoundingClientRect();
    const out = element(".palm-out").getBoundingClientRect();
    const more = element(".palm-action-more").getBoundingClientRect();

    expect(bar.left).toBe(onList.left);
    expect(bar.top).toBe(onList.top);
    expect(out.left - bar.right).toBe(8);
    expect(out.top).toBe(bar.top);
    expect(more.left - out.right).toBeGreaterThanOrEqual(8);
  });

  // On a list the slot is empty, so the pill is its three buttons and no wider: the stretch
  // into Scrawl's field is what makes it long
  it("keeps the place pill on a list to its buttons", async () => {
    await page.viewport(390, 800);
    mountPhone();

    const bar = element(".place-switch").getBoundingClientRect();
    const places = element(".place-switch-places").getBoundingClientRect();

    expect(bar.height).toBe(56);
    expect(bar.right - places.right).toBe(5);
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
 * Only one status popover hangs off the window. There are two entry points, the status line
 * at the top of the rail (wide window) and the dot in a phone's top corner, but both open the
 * same popover.
 *
 * The base that hangs it under its anchor (`.popover-anchor { top: 100% }`) cannot be used
 * here. `.app` is the full height of the window, so straight below it is off screen and its
 * `overflow: hidden` cuts it away. Pressing it would change only the state and show nothing.
 */
function mountSyncPopover(): HTMLElement {
  document.body.innerHTML = `
    <div class="app">
      <nav class="library"></nav>
      <div class="app-column">
        <main class="app-main"><div class="view"></div></main>
      </div>
      <div class="popover-anchor popover-anchor--sync">
        <div class="popover" style="width: 260px; height: 180px;">sync</div>
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

  // The rail keeps its places at the foot (library.css): the state, a rare thing, is at its
  // top, and its details hang straight under it
  it("opens straight under the library's status line on a wide window", async () => {
    await page.viewport(1280, 800);
    const rect = mountSyncPopover().getBoundingClientRect();

    expect(rect.top).toBeCloseTo(96, 0);
    expect(rect.bottom).toBeLessThanOrEqual(800);
    expect(rect.left).toBeCloseTo(8, 0);
  });

  it("opens inside the window on a phone", async () => {
    await page.viewport(390, 800);
    const rect = mountSyncPopover().getBoundingClientRect();

    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(800);
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(390);
  });
});
