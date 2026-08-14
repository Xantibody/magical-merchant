import { describe, it, expect, afterEach } from "vitest";
import {
  buildLanguageSuggestions,
  ensureLanguageDatalist,
  languageLabelWidth,
  LANGUAGE_DATALIST_ID,
} from "./language-suggestions";

describe("buildLanguageSuggestions", () => {
  it("sorts the loaded languages", () => {
    expect(buildLanguageSuggestions(["ts", "bash", "rust"])).toEqual([
      "bash",
      "mermaid",
      "rust",
      "ts",
    ]);
  });

  // mermaid はハイライト対象外でも図が描ける言語なので、候補から漏らさない
  it("always offers mermaid even though the highlighter does not load it", () => {
    expect(buildLanguageSuggestions([])).toEqual(["mermaid"]);
    expect(buildLanguageSuggestions(["mermaid", "ts"])).toEqual(["mermaid", "ts"]);
  });
});

describe("languageLabelWidth", () => {
  // input の size 属性は平均文字幅ベースで、monospace でも "mermaid" が
  // 「mermai」に欠けた。ch 単位+丸め誤差ぶんの余白で文字数に追従させる
  it("gives every character a ch plus rounding slack", () => {
    expect(languageLabelWidth("mermaid")).toBe("8ch");
  });

  it("keeps room for the placeholder when the value is short or empty", () => {
    expect(languageLabelWidth("js")).toBe("5ch");
    expect(languageLabelWidth("")).toBe("5ch");
  });
});

describe("ensureLanguageDatalist", () => {
  afterEach(() => {
    document.querySelector(`#${LANGUAGE_DATALIST_ID}`)?.remove();
  });

  it("creates a datalist with one option per language", () => {
    const id = ensureLanguageDatalist(document, ["js", "rust"]);

    expect(id).toBe(LANGUAGE_DATALIST_ID);
    const options = document.querySelectorAll(`#${LANGUAGE_DATALIST_ID} option`);
    expect([...options].map((o) => (o as HTMLOptionElement).value)).toEqual(["js", "rust"]);
  });

  // エディタは開き直されるし、ブロックごとに nodeView が立つ。何度呼んでも 1 つ
  it("reuses the existing datalist instead of adding a second one", () => {
    ensureLanguageDatalist(document, ["js"]);
    ensureLanguageDatalist(document, ["js", "rust"]);

    expect(document.querySelectorAll("datalist")).toHaveLength(1);
    const options = document.querySelectorAll(`#${LANGUAGE_DATALIST_ID} option`);
    expect(options).toHaveLength(2);
  });
});
