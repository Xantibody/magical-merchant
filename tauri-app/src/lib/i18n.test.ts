import { describe, it, expect, afterEach } from "vitest";
import { locale, messages, resolveLocale, setLocale, t } from "./i18n";

describe("resolveLocale", () => {
  it("follows the system language when the preference is system", () => {
    expect(resolveLocale("system", "ja-JP")).toBe("ja");
    expect(resolveLocale("system", "en-US")).toBe("en");
  });

  // 対応しているのは日本語と英語だけ。知らない言語は英語に倒す
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
    expect(t().timeline.selectedCount(3)).toContain("3");
  });
});

/** 値の形だけを取り出す。文字列は "string"、関数は "function" になる。 */
function shapeOf(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return typeof value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, inner]) => [key, shapeOf(inner)])
      .toSorted(([a], [b]) => String(a).localeCompare(String(b))),
  );
}

const JAPANESE = /[ぁ-んァ-ヶ一-龥]/u;

/** 日本語の混じっている文字列のキーを、`a.b.c` の形で集める。 */
function japaneseKeys(value: unknown, path: string): string[] {
  if (typeof value === "string") {
    return JAPANESE.test(value) ? [path] : [];
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, inner]) => japaneseKeys(inner, `${path}.${key}`));
}

describe("the two tables", () => {
  // 片方にしかないキーは、その言語でだけ画面が空になる。型でも防いでいるが、
  // 入れ子の取りこぼしはここで気付きたい
  it("have the same shape", () => {
    expect(shapeOf(messages.en)).toStrictEqual(shapeOf(messages.ja));
  });

  it("leaves no english string in japanese characters", () => {
    // 言語の選択肢だけは、その言語自身の名前で出す
    expect(japaneseKeys(messages.en, "en")).toStrictEqual(["en.settings.languageJa"]);
  });
});
