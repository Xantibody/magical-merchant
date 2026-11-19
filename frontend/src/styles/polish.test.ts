import { describe, it, expect } from "vitest";

/**
 * The finish of ADR 0013, read off the stylesheets the way `motion.test.ts` reads motion. The
 * CSS is split per surface, so one more grey or one more shadow only ever looks like "this
 * surface feels a little different"; here it fails by name.
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

/** The size that is a glyph drawn inside a 14px mark, not text anyone reads as a line. */
const SMALL_SIZE_EXCEPTIONS = new Set(["./workspace.css .page-mark-count"]);

function shadowOf(rule: Rule): string {
  return /box-shadow:\s*(?<value>[^;]+)/u.exec(rule.body)?.groups?.value.trim() ?? "";
}

function isUndersized(rule: Rule): boolean {
  const size = /font-size:\s*(?<px>[\d.]+)px/u.exec(rule.body)?.groups?.px;
  return (
    size !== undefined &&
    Number(size) < 13 &&
    Number(size) !== 12 &&
    !SMALL_SIZE_EXCEPTIONS.has(name(rule))
  );
}

function usesLineColourForWords(rule: Rule): boolean {
  return (
    /(?:^|[\s;])color:\s*var\(--app-text-hint\)/u.test(rule.body) &&
    !HINT_TEXT_EXCEPTIONS.has(name(rule))
  );
}

function hasOtherShadow(rule: Rule): boolean {
  return (
    rule.body.includes("box-shadow") &&
    !/^(?:var\(--shadow-pop\)|none.*|0 0 0 \dpx .*|inset .*)$/u.test(shadowOf(rule))
  );
}

function floatsWithBorder(rule: Rule): boolean {
  return (
    shadowOf(rule) === "var(--shadow-pop)" &&
    /(?:^|[\s;])border(?:-(?:top|right|bottom|left))?:\s*(?!\s|none)/u.test(rule.body)
  );
}

function isShadowedToast(rule: Rule): boolean {
  return rule.selector === ".undo-toast" && rule.body.includes("box-shadow");
}

/** The rules a predicate catches, by name. */
function caught(predicate: (rule: Rule) => boolean): string[] {
  return rules()
    .filter((rule) => predicate(rule))
    .map((rule) => name(rule));
}

describe("helper text", () => {
  it("is 12px or 13px at the smallest, and never between", () => {
    expect(caught(isUndersized)).toStrictEqual([]);
  });

  // The step that is left for lines reads 1.5:1 as text
  it("does not use the line colour for words", () => {
    expect(caught(usesLineColourForWords)).toStrictEqual([]);
  });
});

describe("elevation", () => {
  it("has one shadow; only cancelling it, a focus ring and an inset mark are something else", () => {
    expect(caught(hasOtherShadow)).toStrictEqual([]);
  });

  it("draws no border round a box that floats", () => {
    expect(caught(floatsWithBorder)).toStrictEqual([]);
  });

  // Its dark ground already lifts it
  it("leaves the toast without a shadow", () => {
    expect(caught(isShadowedToast)).toStrictEqual([]);
  });
});
