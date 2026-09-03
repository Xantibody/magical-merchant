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
        tags: ["sf6", "ベガ", "置き攻め"],
      });
    });

    // タグの文字は Timeline のチップと同じ規則で寄せる。大文字の SF6 も sf6 と同じタグ
    it("normalises typed tags the way the timeline chips do", () => {
      expect(searchRequest("#SF6", [])).toStrictEqual({ query: "", tags: ["sf6"] });
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
  it("carries the timeline's active tag into the palette", () => {
    expect(paletteScopeAt(ROUTES.TIMELINE, "sync")).toStrictEqual({ tags: ["sync"] });
  });

  it("opens an unscoped palette when no tag is active", () => {
    expect(paletteScopeAt(ROUTES.TIMELINE, null)).toBeUndefined();
  });

  // Notes 画面には絞り込みチップが無い。見えていない範囲を黙って掛けない
  it("ignores the timeline tag on other routes", () => {
    expect(paletteScopeAt(ROUTES.NOTES, "sync")).toBeUndefined();
  });
});
