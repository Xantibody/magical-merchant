import { describe, it, expect } from "vitest";
import { paletteScopeAt, searchRequest } from "./search-scope";
import { ROUTES } from "./routes";

describe("searchRequest", () => {
  it("does not search when nothing is typed and no tag is set", () => {
    expect(searchRequest("   ", null)).toBeNull();
  });

  it("searches the typed text across everything without a tag", () => {
    expect(searchRequest("retry", null)).toEqual({ query: "retry", tags: [] });
  });

  // タグで絞った状態は、何も打たなくても眺められる一覧になる
  it("lists everything under the tag when only a tag is set", () => {
    expect(searchRequest("", "sync")).toEqual({ query: "", tags: ["sync"] });
  });

  it("narrows the typed text to the tag", () => {
    expect(searchRequest("retry", "sync")).toEqual({ query: "retry", tags: ["sync"] });
  });
});

describe("paletteScopeAt", () => {
  it("carries the timeline's active tag into the palette", () => {
    expect(paletteScopeAt(ROUTES.TIMELINE, "sync")).toEqual({ tag: "sync" });
  });

  it("opens an unscoped palette when no tag is active", () => {
    expect(paletteScopeAt(ROUTES.TIMELINE, null)).toBeUndefined();
  });

  // Notes 画面には絞り込みチップが無い。見えていない範囲を黙って掛けない
  it("ignores the timeline tag on other routes", () => {
    expect(paletteScopeAt(ROUTES.NOTES, "sync")).toBeUndefined();
  });
});
