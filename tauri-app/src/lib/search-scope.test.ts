import { describe, it, expect } from "vitest";
import { paletteScopeAt, scopeLabel, searchRequest } from "./search-scope";
import { ROUTES } from "./routes";

describe("searchRequest", () => {
  it("does not search when nothing is typed and no tag is set", () => {
    expect(searchRequest("   ", [])).toBeNull();
  });

  it("searches the typed text across everything without a tag", () => {
    expect(searchRequest("retry", [])).toStrictEqual({ query: "retry", tags: [] });
  });

  // タグで絞った状態は、何も打たなくても眺められる一覧になる
  it("lists everything under the chip when only a chip is set", () => {
    expect(searchRequest("", ["sync"])).toStrictEqual({ query: "", tags: ["sync"] });
  });

  it("narrows the typed text to the chip", () => {
    expect(searchRequest("retry", ["sync"])).toStrictEqual({ query: "retry", tags: ["sync"] });
  });

  // チップは AND。両方付いている記録だけが残る
  it("requires every chip at once", () => {
    expect(searchRequest("", ["sf6", "ベガ"])).toStrictEqual({ query: "", tags: ["sf6", "ベガ"] });
  });

  describe("typed #tags", () => {
    it("turns one typed tag into scope and leaves no text", () => {
      expect(searchRequest("#sync", [])).toStrictEqual({ query: "", tags: ["sync"] });
    });

    // 「#SF6 #ベガ #置き攻め」と打つだけで、三つ全部の付いた記録が並ぶ
    it("turns several typed tags into an AND scope", () => {
      expect(searchRequest("#SF6 #ベガ #置き攻め", [])).toStrictEqual({
        query: "",
        tags: ["SF6", "ベガ", "置き攻め"],
      });
    });

    // タグの文字は Scrawl のチップと同じ規則。打った綴りがそのまま範囲になる
    it("keeps the spelling of typed tags the way the scrawl chips do", () => {
      expect(searchRequest("#SF6", [])).toStrictEqual({ query: "", tags: ["SF6"] });
    });

    it("keeps the remaining text as the query, without the tag tokens", () => {
      expect(searchRequest("#sf6 コンボ", [])).toStrictEqual({ query: "コンボ", tags: ["sf6"] });
    });

    it("collapses the gap a removed tag leaves in the middle of the text", () => {
      expect(searchRequest("中 #sf6  段", [])).toStrictEqual({ query: "中 段", tags: ["sf6"] });
    });

    it("adds typed tags after the chips", () => {
      expect(searchRequest("#ベガ", ["sf6"])).toStrictEqual({ query: "", tags: ["sf6", "ベガ"] });
    });

    it("does not repeat a tag that is both typed and chipped", () => {
      expect(searchRequest("#sync #sync", ["sync"])).toStrictEqual({ query: "", tags: ["sync"] });
      expect(searchRequest("#Sync", ["sync"])).toStrictEqual({ query: "", tags: ["sync"] });
    });

    // `C#` や URL の `#frag` はタグではない。本文の規則(tags.ts)をそのまま使う
    it("leaves a hash that is not a tag in the text", () => {
      expect(searchRequest("C# 入門", [])).toStrictEqual({ query: "C# 入門", tags: [] });
    });
  });
});

describe("scopeLabel", () => {
  it("joins the tags with their hashes", () => {
    expect(scopeLabel(["sf6", "ベガ"])).toBe("#sf6 #ベガ");
  });
});

describe("paletteScopeAt", () => {
  it("carries the tag the browse screen is narrowed by into the palette", () => {
    expect(paletteScopeAt(ROUTES.BROWSE, ["sync"])).toStrictEqual({ tags: ["sync"] });
  });

  it("opens an unscoped palette when no tag is chosen", () => {
    expect(paletteScopeAt(ROUTES.BROWSE, [])).toBeUndefined();
  });

  /**
   * 絞る画面のタグは「どれかを持つ」、`search_all` の tags は「全部を持つ」。
   * 2 つ以上をそのまま渡すと、画面に出ている記録のうち片方しか持たないものが
   * 開いた瞬間に消える。引き継がないほうが嘘をつかない
   */
  it("inherits nothing when two tags are chosen, since the two sides disagree", () => {
    expect(paletteScopeAt(ROUTES.BROWSE, ["sync", "perf"])).toBeUndefined();
  });

  // Scrawl のチップは押すと絞る画面を開くだけで、その場では絞らない。
  // 見えていない範囲を黙って掛けない
  it("ignores the tags on every other route", () => {
    expect(paletteScopeAt(ROUTES.SCRAWL, ["sync"])).toBeUndefined();
    expect(paletteScopeAt(ROUTES.NOTES, ["sync"])).toBeUndefined();
  });
});
