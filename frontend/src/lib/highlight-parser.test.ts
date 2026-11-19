import { describe, it, expect, vi } from "vitest";
import { withKnownLanguages } from "./highlight-parser";
import type { Parser } from "@milkdown/plugin-highlight/shiki";

const LOADED = ["javascript", "js", "typescript", "ts", "rust"];

function parserOptions(language?: string) {
  return { content: "let x = 1;", language, pos: 0, size: 12 };
}

describe("withKnownLanguages", () => {
  it("delegates to the inner parser for a loaded language", () => {
    const inner = vi.fn<Parser>().mockReturnValue([]);
    const parser = withKnownLanguages(inner, LOADED);

    const result = parser(parserOptions("rust"));

    expect(inner).toHaveBeenCalledExactlyOnceWith(parserOptions("rust"));
    expect(result).toStrictEqual([]);
  });

  // The fence info string is typed by hand, so upper case and surrounding
  // whitespace are common variations. Shiki's language IDs are lower case, so
  // normalise before matching and delegating
  it("normalizes case and whitespace before matching", () => {
    const inner = vi.fn<Parser>().mockReturnValue([]);
    const parser = withKnownLanguages(inner, LOADED);

    parser(parserOptions(" TS "));

    expect(inner).toHaveBeenCalledExactlyOnceWith(parserOptions("ts"));
  });

  // Passing a language Shiki has not loaded throws a ShikiError, and
  // prosemirror-highlight logs a console error and then abandons the
  // highlighting of the following blocks as well (issue #101)
  it("returns no decorations for a language the highlighter has not loaded", () => {
    const inner = vi.fn<Parser>();
    const parser = withKnownLanguages(inner, LOADED);

    const result = parser(parserOptions("mermaid"));

    expect(inner).not.toHaveBeenCalled();
    expect(result).toStrictEqual([]);
  });

  it("returns no decorations when the language is missing or empty", () => {
    const inner = vi.fn<Parser>();
    const parser = withKnownLanguages(inner, LOADED);

    expect(parser(parserOptions())).toStrictEqual([]);
    expect(parser(parserOptions(""))).toStrictEqual([]);
    expect(inner).not.toHaveBeenCalled();
  });
});
