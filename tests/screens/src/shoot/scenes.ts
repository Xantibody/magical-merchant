// Every scene shoot takes: where it starts, what is done to reach it, and what shows once it is
// there. The surfaces and states are CLAUDE.md's UI Architecture, over the records in fixtures/.

import type { ChainablePromiseElement } from "webdriverio";

export type Width = "wide" | "phone";

export interface Scene {
  name: string;
  widths: Width[];
  /** Path and query, loaded fresh for every shot. */
  url: string;
  /** localStorage on top of the shot's own (theme, language, first run seen); null removes a key. */
  storage?: Record<string, string | null>;
  /** What is done once the page is up. */
  act?: (browser: WebdriverIO.Browser, width: Width) => Promise<void>;
  /** Present once the scene is reached. */
  ready: string | ((width: Width) => string);
}

const both: Width[] = ["wide", "phone"];

/** The note most scenes open: tags, a link, a list. */
const note = "/notes?file=20260801_093000.md";
/** The one Codex, three versions behind its draft. */
const codex = "/codex?file=20260701_090000.md";

/** Ctrl, not ⌘: the app takes either, and ⌘ would reach the macOS menu first (⌘H, ⌘W). */
async function press(browser: WebdriverIO.Browser, ...keys: string[]): Promise<void> {
  await browser.keys(["Control", ...keys]);
}

/**
 * A press and release where it stands, as a finger would: the ring opens on pointer events,
 * which a WebDriver click may not send.
 */
async function tap(browser: WebdriverIO.Browser, selector: string): Promise<void> {
  const element = await browser.$(selector);
  await element.waitForExist({ timeout: 10_000 });
  await browser.execute((target: Element) => {
    const box = target.getBoundingClientRect();
    const at = {
      bubbles: true,
      button: 0,
      clientX: box.x + box.width / 2,
      clientY: box.y + box.height / 2,
      isPrimary: true,
      pointerId: 1,
      pointerType: "mouse",
    };
    target.dispatchEvent(new PointerEvent("pointerdown", at));
    target.dispatchEvent(new PointerEvent("pointerup", at));
  }, element);
}

/**
 * The element's own click, as a script: WebDriver's click leaves the pointer over the element and
 * the focus ring on it, which a shot of what the click opened would then carry.
 */
async function clickOn(
  browser: WebdriverIO.Browser,
  element: WebdriverIO.Element | ChainablePromiseElement,
): Promise<void> {
  await browser.execute((target: HTMLElement) => {
    target.click();
  }, element);
}

async function click(browser: WebdriverIO.Browser, selector: string): Promise<void> {
  const element = await browser.$(selector);
  await element.waitForExist({ timeout: 10_000 });
  await clickOn(browser, element);
}

/** The + that opens the ring: the rail's on a wide window, the list's on a phone. */
function ringButton(width: Width): string {
  return width === "wide" ? ".library .library-ring" : ".list-pane .list-plus";
}

/** The ring's petals in their fixed order (`lib/ring.ts`): Scrawl, Note, Codex, template. */
async function petal(browser: WebdriverIO.Browser, width: Width, index: number): Promise<void> {
  await tap(browser, ringButton(width));
  const petals = await browser.$$(".ring-layer .ring-petal");
  const target = petals[index];
  if (target === undefined) {
    throw new Error(`the ring shows ${petals.length} petals, not ${index + 1}`);
  }
  await clickOn(browser, target);
}

export const scenes: Scene[] = [
  {
    name: "first-run",
    widths: both,
    url: "/",
    storage: { "first-run-dismissed": null },
    ready: ".first-run-overlay .first-run",
  },
  { name: "scrawl", widths: both, url: "/", ready: '.day-group[data-day="2026-08-01"]' },
  {
    name: "scrawl-entry-open",
    widths: both,
    url: "/",
    // The newest line: one further down is scrolled to, and on a phone reading down folds the bar
    act: (browser) => click(browser, "[data-entry] .entry-text"),
    ready: ".entry-open",
  },
  {
    name: "scrawl-calendar",
    widths: both,
    url: "/",
    act: (browser) => click(browser, ".scrawl-head > .icon-button[aria-expanded]"),
    ready: ".popover-anchor--calendar",
  },
  {
    name: "search",
    widths: both,
    url: "/notes",
    act: (browser) => press(browser, "k"),
    ready: ".search .palette-row",
  },
  {
    name: "search-query",
    widths: both,
    url: "/notes",
    act: async (browser) => {
      await press(browser, "k");
      const field = await browser.$(".search-input");
      await field.waitForExist({ timeout: 10_000 });
      await field.setValue("flyout");
    },
    ready: ".search .palette-count",
  },
  {
    name: "palette",
    widths: ["wide"],
    url: note,
    act: (browser) => browser.keys(["?"]),
    ready: ".palette[role=dialog]",
  },
  {
    name: "ring",
    widths: both,
    url: "/notes",
    act: (browser, width) => tap(browser, ringButton(width)),
    ready: ".ring-layer .ring-petal",
  },
  {
    name: "quick-jot",
    widths: both,
    url: "/notes",
    act: (browser, width) => petal(browser, width, 0),
    ready: ".quick-jot",
  },
  {
    name: "template-picker",
    widths: both,
    url: "/notes",
    act: (browser, width) => petal(browser, width, 3),
    ready: ".template-picker",
  },
  {
    name: "status-details",
    widths: both,
    url: codex,
    act: (browser, width) =>
      click(browser, width === "wide" ? ".library .status-line" : ".palm-dot .status-dot"),
    ready: ".sync-popover .status-details",
  },
  { name: "notes-list", widths: ["phone"], url: "/notes", ready: ".list-pane .list-row" },
  { name: "note-viewer", widths: both, url: note, ready: ".note-title-view" },
  {
    name: "note-code-mermaid",
    widths: both,
    url: "/notes?file=20260802_141500.md",
    ready: ".mermaid-figure svg",
  },
  {
    name: "note-mindmap",
    widths: both,
    url: "/notes?file=20260804_170000.md",
    ready: ".mindmap-view svg g",
  },
  { name: "note-writing", widths: both, url: `${note}&edit=1`, ready: ".ProseMirror" },
  {
    name: "note-panel",
    widths: both,
    url: "/notes?file=20260806_120000.md",
    act: (browser) => press(browser, "."),
    ready: (width) => (width === "wide" ? ".note-panel" : ".note-sheet"),
  },
  {
    // Wide only: the phone's sheet opens at its middle stop, under which the details are cut
    name: "note-panel-details",
    widths: ["wide"],
    url: note,
    act: (browser) => press(browser, "Shift", "I"),
    ready: ".note-panel-details",
  },
  {
    name: "note-list-tucked",
    widths: ["wide"],
    url: note,
    storage: { "list-tucked": "tucked" },
    ready: ".workspace--tucked",
  },
  { name: "codex-list", widths: ["phone"], url: "/codex", ready: ".list-row--codex" },
  { name: "codex-viewer", widths: both, url: codex, ready: ".note-title-view" },
  {
    name: "codex-history",
    widths: both,
    url: codex,
    act: (browser) => press(browser, "Shift", "H"),
    ready: ".history-panel .history-row",
  },
  { name: "browse", widths: both, url: "/browse", ready: ".browse-row" },
  { name: "browse-tag", widths: both, url: "/browse?tag=design", ready: ".browse-row" },
  { name: "settings", widths: ["phone"], url: "/settings", ready: ".settings-nav" },
  {
    name: "settings-general",
    widths: both,
    url: "/settings?page=general",
    ready: ".settings-page-title",
  },
  {
    name: "settings-records",
    widths: both,
    url: "/settings?page=records",
    ready: ".settings-page-title",
  },
  {
    name: "settings-sync",
    widths: both,
    url: "/settings?page=sync",
    ready: ".settings-page-title",
  },
  { name: "templates", widths: both, url: "/templates", ready: ".templates .list-row" },
  {
    name: "template-editor",
    widths: both,
    url: "/templates",
    act: async (browser) => {
      // webdriverio's own map on $$ answers a promise; a plain array maps as usual
      const rows = [...(await browser.$$(".templates .list-row"))];
      const titles = await Promise.all(rows.map((row) => row.getText()));
      const daily = rows[titles.findIndex((title) => title.includes("daily"))];
      if (daily === undefined) {
        throw new Error(`no template row reads "daily": ${titles.join(" / ")}`);
      }
      await clickOn(browser, daily);
    },
    ready: ".templates-tabs",
  },
];
