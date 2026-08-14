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
    expect(result).toEqual([]);
  });

  // フェンスの info 文字列は手打ちなので、大文字や前後の空白はよくある揺れ。
  // Shiki の言語 ID は小文字なので、正規化してから照合・委譲する
  it("normalizes case and whitespace before matching", () => {
    const inner = vi.fn<Parser>().mockReturnValue([]);
    const parser = withKnownLanguages(inner, LOADED);

    parser(parserOptions(" TS "));

    expect(inner).toHaveBeenCalledExactlyOnceWith(parserOptions("ts"));
  });

  // 読み込んでいない言語を Shiki に渡すと ShikiError が投げられ、
  // prosemirror-highlight が console error を出した上で後続ブロックの
  // ハイライトまで打ち切ってしまう(issue #101)
  it("returns no decorations for a language the highlighter has not loaded", () => {
    const inner = vi.fn<Parser>();
    const parser = withKnownLanguages(inner, LOADED);

    const result = parser(parserOptions("mermaid"));

    expect(inner).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("returns no decorations when the language is missing or empty", () => {
    const inner = vi.fn<Parser>();
    const parser = withKnownLanguages(inner, LOADED);

    expect(parser(parserOptions())).toEqual([]);
    expect(parser(parserOptions(""))).toEqual([]);
    expect(inner).not.toHaveBeenCalled();
  });
});
