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

  // Narrowed by a tag is a list you can browse without typing anything
  it("lists everything under the chip when only a chip is set", () => {
    expect(searchRequest("", ["sync"])).toStrictEqual({ query: "", tags: ["sync"] });
  });

  it("narrows the typed text to the chip", () => {
    expect(searchRequest("retry", ["sync"])).toStrictEqual({ query: "retry", tags: ["sync"] });
  });

  // Chips are AND. Only records carrying both survive
  it("requires every chip at once", () => {
    expect(searchRequest("", ["sf6", "ベガ"])).toStrictEqual({ query: "", tags: ["sf6", "ベガ"] });
  });

  describe("typed #tags", () => {
    it("turns one typed tag into scope and leaves no text", () => {
      expect(searchRequest("#sync", [])).toStrictEqual({ query: "", tags: ["sync"] });
    });

    // Just typing `#SF6 #ベガ #置き攻め` lists the records carrying all three
    it("turns several typed tags into an AND scope", () => {
      expect(searchRequest("#SF6 #ベガ #置き攻め", [])).toStrictEqual({
        query: "",
        tags: ["SF6", "ベガ", "置き攻め"],
      });
    });

    // Tag text follows the same rule as the Scrawl chips. The typed spelling is the scope
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

    // `C#` and a URL's `#frag` are not tags. The body's rule (`tags.ts`) is used as is
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
   * A tag on the Browse screen means "has any of them"; `tags` in `search_all` means
   * "has all of them". Passing two or more through unchanged makes the records on
   * screen that carry only one of them vanish the moment the palette opens. Inheriting
   * nothing tells fewer lies
   */
  it("inherits nothing when two tags are chosen, since the two sides disagree", () => {
    expect(paletteScopeAt(ROUTES.BROWSE, ["sync", "perf"])).toBeUndefined();
  });

  // A Scrawl chip only opens the Browse screen when pressed; it does not narrow in
  // place. A scope that is not visible is never applied silently
  it("ignores the tags on every other route", () => {
    expect(paletteScopeAt(ROUTES.SCRAWL, ["sync"])).toBeUndefined();
    expect(paletteScopeAt(ROUTES.NOTES, ["sync"])).toBeUndefined();
  });
});
