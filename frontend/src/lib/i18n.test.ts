import { describe, it, expect, afterEach } from "vitest";
import { locale, messages, resolveLocale, setLocale, t } from "./i18n";

describe("resolveLocale", () => {
  it("follows the system language when the preference is system", () => {
    expect(resolveLocale("system", "ja-JP")).toBe("ja");
    expect(resolveLocale("system", "en-US")).toBe("en");
  });

  // Only Japanese and English are supported. An unknown language falls to English
  it("falls back to english for a language we do not have", () => {
    expect(resolveLocale("system", "de-DE")).toBe("en");
  });

  it("keeps an explicit choice whatever the system says", () => {
    expect(resolveLocale("en", "ja-JP")).toBe("en");
    expect(resolveLocale("ja", "en-US")).toBe("ja");
  });
});

describe("t", () => {
  afterEach(() => setLocale("ja"));

  it("returns the table for the active locale", () => {
    setLocale("ja");
    expect(t().common.save).toBe("保存");
    setLocale("en");
    expect(t().common.save).toBe("Save");
  });

  it("keeps the locale readable for anything that needs it", () => {
    setLocale("en");
    expect(locale()).toBe("en");
  });

  it("fills in the numbers a sentence needs", () => {
    setLocale("en");
    expect(t().scrawl.selectedCount(3)).toContain("3");
  });
});

const JAPANESE = /[ぁ-んァ-ヶ一-龥]/u;

/**
 * Translated spellings of a surface name. The three surfaces are proper nouns, so both
 * languages write Scrawl / Note / Codex (#255). For English only the lowercase spellings
 * are picked up: with `\b` and case sensitivity, a correct `Note` is not matched.
 */
const TRANSLATED_SURFACE_NAME = /ノート|メモ|タイムライン|\b(?:notes?|timelines?)\b/u;

/**
 * Collect the keys of the strings that match `re`, in `a.b.c` form. Only strings are
 * looked at; a sentence a function assembles does not pass through.
 */
function keysMatching(value: unknown, path: string, re: RegExp): string[] {
  if (typeof value === "string") {
    return re.test(value) ? [path] : [];
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, inner]) => keysMatching(inner, `${path}.${key}`, re));
}

describe("the two tables", () => {
  it("leaves no english string in japanese characters", () => {
    // The language choices alone are shown under the name of the language itself
    expect(keysMatching(messages.en, "en", JAPANESE)).toStrictEqual(["en.settings.languageJa"]);
  });

  // One translated spelling mixed in and the same surface goes by Note in the tab and by a
  // translated word in a sentence. A follow-on to #255, which renamed only the labels
  // (`routes.ts`)
  it("never spells a surface name any way but Scrawl, Note and Codex", () => {
    expect(keysMatching(messages.ja, "ja", TRANSLATED_SURFACE_NAME)).toStrictEqual([]);
    expect(keysMatching(messages.en, "en", TRANSLATED_SURFACE_NAME)).toStrictEqual([]);
  });
});
