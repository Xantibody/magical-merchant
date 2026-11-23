import { describe, it, expect, afterEach } from "vitest";
import {
  buildLanguageSuggestions,
  ensureLanguageDatalist,
  LANGUAGE_DATALIST_ID,
} from "./language-suggestions";

describe("buildLanguageSuggestions", () => {
  it("sorts the loaded languages", () => {
    expect(buildLanguageSuggestions(["ts", "bash", "rust"])).toStrictEqual([
      "bash",
      "mermaid",
      "rust",
      "ts",
    ]);
  });

  // mermaid draws a diagram even though it is not highlighted, so it never drops out
  it("always offers mermaid even though the highlighter does not load it", () => {
    expect(buildLanguageSuggestions([])).toStrictEqual(["mermaid"]);
    expect(buildLanguageSuggestions(["mermaid", "ts"])).toStrictEqual(["mermaid", "ts"]);
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
    expect([...options].map((o) => (o as HTMLOptionElement).value)).toStrictEqual(["js", "rust"]);
  });

  // The editor is reopened, and a nodeView stands up per block. However many calls, one
  it("reuses the existing datalist instead of adding a second one", () => {
    ensureLanguageDatalist(document, ["js"]);
    ensureLanguageDatalist(document, ["js", "rust"]);

    expect(document.querySelectorAll("datalist")).toHaveLength(1);
    const options = document.querySelectorAll(`#${LANGUAGE_DATALIST_ID} option`);
    expect(options).toHaveLength(2);
  });
});
