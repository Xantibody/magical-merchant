import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { userEvent } from "vitest/browser";

/**
 * One focus ring. Left to normalize, the browser drew its own ring in normalize's indigo link
 * colour, 5px out, the only chromatic thing on a grey screen; and the fields drew a 3px soft
 * ring that read 1.2:1 against the field. The ring is read off the stylesheets the way
 * `polish.test.ts` reads the finish, and off controls the keyboard really reached.
 */

const sources = import.meta.glob("./*.css", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

interface Rule {
  file: string;
  selector: string;
  body: string;
}

/** Innermost rules, so one inside `@media` reads as itself. Comments are not code. */
function rules(): Rule[] {
  const found: Rule[] = [];
  for (const [file, css] of Object.entries(sources)) {
    const code = css.replaceAll(/\/\*.*?\*\//gsu, "");
    for (const match of code.matchAll(/(?<selector>[^{}]+)\{(?<body>[^{}]*)\}/gu)) {
      found.push({
        file,
        selector: (match.groups?.selector ?? "").trim().replaceAll(/\s+/gu, " "),
        body: match.groups?.body ?? "",
      });
    }
  }
  return found;
}

/** Each `property: value` in a rule whose property `pattern` matches. */
function values(rule: Rule, pattern: RegExp): string[] {
  return rule.body
    .split(";")
    .map((declaration) => declaration.split(":"))
    .filter(([property]) => pattern.test(property?.trim() ?? ""))
    .map(([, ...value]) => value.join(":").trim());
}

/** Whether an outline value draws anything at all. */
function draws(value: string): boolean {
  return !/^(?:none|0|0px)(?:\s*!important)?$/u.test(value);
}

/** Outline declarations that paint, as `file selector { value }`. */
function outlines(predicate: (rule: Rule, value: string) => boolean): string[] {
  return rules().flatMap((rule) =>
    values(rule, /^outline(?:-color)?$/u)
      .filter((value) => draws(value) && predicate(rule, value))
      .map((value) => `${rule.file} ${rule.selector} { ${value} }`),
  );
}

function isFocusRule(rule: Rule): boolean {
  return rule.selector.includes(":focus");
}

function anyOutline(): boolean {
  return true;
}

function outsideTheTokens(_rule: Rule, value: string): boolean {
  return !value.includes("var(--app-");
}

function focusOutsideTheFocusToken(rule: Rule, value: string): boolean {
  return isFocusRule(rule) && !value.includes("var(--app-focus)");
}

/** What a focus rule paints besides an outline, when it is not the focus token. */
function softerMarks(rule: Rule): string[] {
  return [
    ...values(rule, /^box-shadow$/u).filter((value) => value !== "none"),
    ...values(rule, /^border(?:-(?:top|right|bottom|left))?-color$/u).filter(
      (value) => value !== "var(--app-focus)",
    ),
  ].map((value) => `${rule.file} ${rule.selector} { ${value} }`);
}

describe("the focus ring in the stylesheets", () => {
  it("has something to read", () => {
    expect(outlines(anyOutline).length).toBeGreaterThan(0);
  });

  // A colour written by hand is right in one theme only, and the browser's indigo came in
  // exactly that way
  it("draws every outline in a token", () => {
    expect(outlines(outsideTheTokens)).toStrictEqual([]);
  });

  // The selected table cell keeps its accent outline: it marks a cell, not the focus
  it("draws every focus outline in --app-focus", () => {
    expect(outlines(focusOutsideTheFocusToken)).toStrictEqual([]);
  });

  // The soft 3px ring was the field's whole focus treatment, and it was the one that vanished
  it("marks a focused field with --app-focus and nothing softer", () => {
    expect(
      rules()
        .filter((rule) => isFocusRule(rule))
        .flatMap((rule) => softerMarks(rule)),
    ).toStrictEqual([]);
  });
});

/** sRGB bytes of any colour the browser can parse, `oklab()` from `color-mix()` included. */
function bytes(colour: string): [number, number, number] {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("expected a 2d canvas");
  }
  context.fillStyle = colour;
  context.fillRect(0, 0, 1, 1);
  const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;
  return [red, green, blue];
}

/** WCAG relative luminance. */
function luminance(colour: string): number {
  const [red = 0, green = 0, blue = 0] = bytes(colour).map((byte) => {
    const value = byte / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(one: string, other: string): number {
  const [light = 0, dark = 0] = [luminance(one), luminance(other)].toSorted((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

/** A token resolved to the colour it computes to in the current theme. */
function token(name: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const { color } = getComputedStyle(probe);
  probe.remove();
  return color;
}

/** What a ring can sit on: the page, a panel, a field, a chosen row. */
const GROUNDS = [
  "--app-surface",
  "--app-surface-2",
  "--app-sidebar",
  "--app-input-bg",
  "--app-accent-soft",
];

const THEMES = ["light", "dark"];

/** Put the keyboard on `target` the way a person does, by tabbing to it. */
async function tabTo(target: HTMLElement): Promise<CSSStyleDeclaration> {
  const before = document.createElement("button");
  before.textContent = "before";
  target.before(before);
  before.focus();
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(target);
  return getComputedStyle(target);
}

function mount(html: string): HTMLElement {
  document.body.innerHTML = `<div class="focus-fixture">${html}</div>`;
  const target = document.querySelector<HTMLElement>("[data-target]");
  if (!target) {
    throw new Error("expected a [data-target] in the fixture");
  }
  return target;
}

describe("the focus ring on screen", () => {
  beforeAll(async () => {
    await import("../index.css");
    await import("./settings.css");
    await import("./workspace.css");
    await import("./history.css");
    await import("./browse.css");
    await import("./note-panel.css");
  });

  afterEach(() => {
    document.body.innerHTML = "";
    delete document.documentElement.dataset.theme;
  });

  // WCAG 1.4.11: a focus indicator is a graphic that has to be told from what it sits on
  it.each(THEMES)("reads at 3:1 or more on every ground in the %s theme", (theme) => {
    document.documentElement.dataset.theme = theme;
    const focus = token("--app-focus");

    for (const ground of GROUNDS) {
      expect(contrast(focus, token(ground)), `--app-focus on ${ground}`).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(THEMES)("rings a button in --app-focus, 2px out, in the %s theme", async (theme) => {
    document.documentElement.dataset.theme = theme;
    const style = await tabTo(mount(`<button class="icon-button" data-target>x</button>`));

    expect(style.outlineStyle).toBe("solid");
    expect(style.outlineWidth).toBe("2px");
    expect(style.outlineColor).toBe(token("--app-focus"));
    expect(style.outlineOffset).toBe("2px");
  });

  it.each(["settings-input", "first-run-input"])(
    "draws the same ring on the edge of a %s",
    async (field) => {
      const style = await tabTo(mount(`<input class="${field}" data-target>`));

      expect(style.outlineStyle).toBe("solid");
      expect(style.outlineWidth).toBe("2px");
      expect(style.outlineColor).toBe(token("--app-focus"));
      expect(style.outlineOffset).toBe("-2px");
      expect(style.boxShadow).toBe("none");
    },
  );

  // A ring 2px out would spill onto the next row's fill, or be cut off by the column
  it.each([
    ["the note list", `<button class="list-row" data-target>a</button>`],
    ["the history", `<button class="history-row" data-target>a</button>`],
    ["the search results", `<button class="palette-row" data-target>a</button>`],
    ["Browse's list", `<button class="browse-row" data-target>a</button>`],
    ["Browse's facets", `<button class="browse-chip" data-target>a</button>`],
    ["the settings menu", `<button class="settings-nav-row" data-target>a</button>`],
    ["the note panel", `<button class="note-panel-row" data-target>a</button>`],
  ])("draws the ring inside a row of %s", async (_place, html) => {
    const style = await tabTo(mount(html));

    expect(style.outlineColor).toBe(token("--app-focus"));
    expect(style.outlineOffset).toBe("-2px");
  });

  // The ring answers the keyboard. A click already shows where it landed
  it("draws no ring where a click put the focus", async () => {
    const button = mount(`<button class="icon-button" data-target>x</button>`);

    await userEvent.click(button);

    expect(document.activeElement).toBe(button);
    expect(getComputedStyle(button).outlineStyle).toBe("none");
  });
});
