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

/** Owned by the status line's own change. To go when that lands. */
const HINT_TEXT_EXCEPTIONS = new Set(["./layout.css .bottom-bar-sep"]);

describe("helper text", () => {
  it("is 12px or 13px at the smallest, and never between", () => {
    const small = rules().filter((rule) => {
      const size = /font-size:\s*(?<px>[\d.]+)px/u.exec(rule.body)?.groups?.px;
      return (
        size !== undefined &&
        Number(size) < 13 &&
        Number(size) !== 12 &&
        !SMALL_SIZE_EXCEPTIONS.has(name(rule))
      );
    });

    expect(small.map(name)).toEqual([]);
  });

  // The step that is left for lines reads 1.5:1 as text
  it("does not use the line colour for words", () => {
    const words = rules().filter(
      (rule) =>
        /(?:^|[\s;])color:\s*var\(--app-text-hint\)/u.test(rule.body) &&
        !HINT_TEXT_EXCEPTIONS.has(name(rule)),
    );

    expect(words.map(name)).toEqual([]);
  });
});

describe("elevation", () => {
  const shadows = (): Rule[] => rules().filter((rule) => rule.body.includes("box-shadow"));
  const value = (rule: Rule): string =>
    /box-shadow:\s*(?<value>[^;]+)/u.exec(rule.body)?.groups?.value.trim() ?? "";

  it("has one shadow; only cancelling it, a focus ring and an inset mark are something else", () => {
    const other = shadows().filter(
      (rule) => !/^(?:var\(--shadow-pop\)|none.*|0 0 0 \dpx .*|inset .*)$/u.test(value(rule)),
    );

    expect(other.map(name)).toEqual([]);
  });

  it("draws no border round a box that floats", () => {
    const boxed = shadows().filter(
      (rule) =>
        value(rule) === "var(--shadow-pop)" &&
        /(?:^|[\s;])border(?:-(?:top|right|bottom|left))?:\s*(?!\s|none)/u.test(rule.body),
    );

    expect(boxed.map(name)).toEqual([]);
  });

  // Its dark ground already lifts it
  it("leaves the toast without a shadow", () => {
    const toast = rules().find((rule) => rule.selector === ".undo-toast");

    expect(toast?.body).not.toContain("box-shadow");
  });
});
