import { describe, it, expect, afterEach } from "vitest";
import {
  buildLanguageSuggestions,
  ensureLanguageDatalist,
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
