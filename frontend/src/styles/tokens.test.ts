import { describe, it, expect, beforeAll, afterEach } from "vitest";

/**
 * The colour tokens, read the way `polish.test.ts` reads the finish. A token is only a promise
 * if every surface goes through it: a colour written by hand on one surface looks right in the
 * theme it was tried in and nowhere else.
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

function name(rule: Rule): string {
  return `${rule.file} ${rule.selector}`;
}

/** Every `--app-*` name the stylesheets match with `pattern`, sorted. */
function tokenNames(pattern: RegExp): string[] {
  const names = new Set<string>();
  for (const css of Object.values(sources)) {
    for (const match of css.replaceAll(/\/\*.*?\*\//gsu, "").matchAll(pattern)) {
      names.add(match.groups?.token ?? "");
    }
  }
  return [...names].toSorted();
}

describe("tokens", () => {
  // An undefined custom property makes var() empty without a word: the hover that never
  // shows, the input that is transparent
  it("defines every --app-* token a stylesheet reads", () => {
    const defined = new Set(tokenNames(/(?<token>--app-[\w-]+)\s*:/gu));

    expect(
      tokenNames(/var\(\s*(?<token>--app-[\w-]+)/gu).filter((token) => !defined.has(token)),
    ).toStrictEqual([]);
  });
});

describe("the colour scheme", () => {
  beforeAll(async () => {
    await import("../index.css");
  });

  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  // Open Props' normalize sets it from the OS. A date picker, a scrollbar or a bare button
  // then draws in the OS's scheme over the app's colours
  it.each(["light", "dark"])("draws native controls in the %s theme the app is in", (theme) => {
    document.documentElement.dataset.theme = theme;

    expect(getComputedStyle(document.documentElement).colorScheme).toBe(theme);
  });
});

/** The fills that carry words, and the token those words take. */
const ON_FILL: Record<string, string> = {
  "--app-accent": "--app-on-accent",
  "--app-danger-fill": "--app-on-danger",
};

/**
 * Colours made for words and marks, too light to carry words of their own. A button that
 * writes on one takes the fill beside it instead.
 */
const MARK_ONLY = new Set(["--app-danger"]);

/** A rule that fills with accent or danger and writes its own text colour, but not the token. */
function writesByHand(rule: Rule): boolean {
  const fill = /background(?:-color)?:\s*var\((?<token>--app-[\w-]+)\)/u.exec(rule.body)?.groups
    ?.token;
  const colour = /(?:^|[\s;])color:\s*(?<value>[^;]+)/u.exec(rule.body)?.groups?.value.trim();
  if (fill === undefined || colour === undefined) {
    return false;
  }
  if (MARK_ONLY.has(fill)) {
    return true;
  }
  return fill in ON_FILL && colour !== `var(${ON_FILL[fill]})`;
}

/** WCAG relative luminance of a computed `rgb(r, g, b)`. */
function luminance(rgb: string): number {
  const channels = (rgb.match(/[\d.]+/gu) ?? []).slice(0, 3).map((part) => {
    const value = Number(part) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [red = 0, green = 0, blue = 0] = channels;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(one: string, other: string): number {
  const [light, dark] = [luminance(one), luminance(other)].toSorted((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

/** Text on the fill, as a button would draw it. */
function swatch(fill: string): HTMLElement {
  const element = document.createElement("span");
  element.style.background = `var(${fill})`;
  element.style.color = `var(${ON_FILL[fill]})`;
  element.textContent = "削除";
  document.body.append(element);
  return element;
}

describe("text on a filled accent or danger", () => {
  beforeAll(async () => {
    await import("../index.css");
  });

  afterEach(() => {
    document.body.innerHTML = "";
    delete document.documentElement.dataset.theme;
  });

  // Small words on a button: 4.5:1 is the floor, and the dark theme flips the fills
  it.each(["light", "dark"])("reads at 4.5:1 or more in the %s theme", (theme) => {
    document.documentElement.dataset.theme = theme;

    for (const fill of Object.keys(ON_FILL)) {
      const style = getComputedStyle(swatch(fill));
      expect(
        contrast(style.color, style.backgroundColor),
        `${ON_FILL[fill]} on ${fill}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  // White, gray-0 and the surface each read in one theme only
  it("takes its colour from the on- token, not by hand", () => {
    expect(
      rules()
        .filter((rule) => writesByHand(rule))
        .map((rule) => name(rule)),
    ).toStrictEqual([]);
  });
});
