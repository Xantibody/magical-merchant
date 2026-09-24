import { describe, it, expect } from "vitest";
import {
  countTagLists,
  countTags,
  isNewTag,
  matchTagPrefix,
  parseTags,
  splitTagged,
  suggestTags,
  tagDraftAt,
} from "./tags";

describe("parseTags", () => {
  it("picks up a tag written in the body", () => {
    expect(parseTags("R2 の同期を直す #sync")).toStrictEqual(["sync"]);
  });

  it("picks up japanese tags", () => {
    expect(parseTags("#設計 を見直す")).toStrictEqual(["設計"]);
  });

  it("keeps the order they appear in and drops repeats", () => {
    expect(parseTags("#a と #b と #a")).toStrictEqual(["a", "b"]);
  });

  it("allows underscores and hyphens", () => {
    expect(parseTags("#local-first #note_taking")).toStrictEqual(["local-first", "note_taking"]);
  });

  // A line starting with `# ` is a heading. Counted as a tag, one would land on almost every note.
  it("ignores a markdown heading", () => {
    expect(parseTags("# 見出し\n本文")).toStrictEqual([]);
  });

  it("ignores a hash that is not at a word boundary", () => {
    expect(parseTags("https://example.com/a#frag")).toStrictEqual([]);
    expect(parseTags("C#")).toStrictEqual([]);
  });

  // The same promise as core's tags.rs. The spelling as typed is returned
  it("keeps the spelling a tag was written with", () => {
    expect(parseTags("#CognitiveBias を疑う")).toStrictEqual(["CognitiveBias"]);
  });

  // Counted separately, the same category lines up twice. The spelling seen first is kept
  it("folds case when deduping and keeps the first spelling", () => {
    expect(parseTags("#Rust と #rust と #RUST")).toStrictEqual(["Rust"]);
  });

  it("keeps japanese tags as written", () => {
    expect(parseTags("#設計 #カタカナ")).toStrictEqual(["設計", "カタカナ"]);
  });

  it("finds a tag at the start of a later line", () => {
    expect(parseTags("一行目\n#二行目")).toStrictEqual(["二行目"]);
  });

  // Japanese puts no space between words. Without picking up what follows a full stop, almost everything is lost.
  it("finds a tag right after japanese punctuation", () => {
    expect(parseTags("走った。#run")).toStrictEqual(["run"]);
    expect(parseTags("バグ、#bug を直す")).toStrictEqual(["bug"]);
    expect(parseTags("(#note)")).toStrictEqual(["note"]);
  });

  it("stops a tag at punctuation", () => {
    expect(parseTags("#sync、あとで")).toStrictEqual(["sync"]);
  });
});

describe("countTags", () => {
  it("orders by how often a tag is used", () => {
    const counts = countTags(["#a #b", "#a", "#c #a", "#b"]);

    expect(counts).toStrictEqual([
      { tag: "a", count: 3 },
      { tag: "b", count: 2 },
      { tag: "c", count: 1 },
    ]);
  });

  // Written twice in the same text, that text is still one record.
  it("counts a tag once per text", () => {
    expect(countTags(["#a と #a"])).toStrictEqual([{ tag: "a", count: 1 }]);
  });

  it("breaks ties by name so the order does not wander", () => {
    expect(countTags(["#b #a"]).map((t) => t.tag)).toStrictEqual(["a", "b"]);
  });

  // Split into two chips, the same category has to be pressed twice
  it("counts tags that differ only in case as one chip", () => {
    expect(countTags(["#CognitiveBias", "#cognitivebias"])).toStrictEqual([
      { tag: "CognitiveBias", count: 2 },
    ]);
  });
});

describe("countTagLists", () => {
  it("counts one list as one item, most used first", () => {
    expect(countTagLists([["a", "b"], ["a"], []])).toStrictEqual([
      { tag: "a", count: 2 },
      { tag: "b", count: 1 },
    ]);
  });

  it("keeps the spelling it saw first for tags that differ only in case", () => {
    expect(countTagLists([["Memo"], ["memo"], ["MEMO"]])).toStrictEqual([
      { tag: "Memo", count: 3 },
    ]);
  });

  // frontmatter stays as written, so one record can claim both spellings
  it("counts a list once even when it carries both spellings", () => {
    expect(countTagLists([["Memo", "memo"]])).toStrictEqual([{ tag: "Memo", count: 1 }]);
  });
});

describe("splitTagged", () => {
  it("splits the body into plain text and tags", () => {
    expect(splitTagged("朝ラン #run した")).toStrictEqual([
      { text: "朝ラン ", tag: false },
      { text: "#run", tag: true },
      { text: " した", tag: false },
    ]);
  });

  it("returns one plain segment when there is no tag", () => {
    expect(splitTagged("ただの本文")).toStrictEqual([{ text: "ただの本文", tag: false }]);
  });

  it("handles a tag at the very start and end", () => {
    expect(splitTagged("#a")).toStrictEqual([{ text: "#a", tag: true }]);
  });

  it("keeps an empty body empty", () => {
    expect(splitTagged("")).toStrictEqual([]);
  });
});

describe("tagDraftAt", () => {
  it("reads the tag being typed just before the caret", () => {
    expect(tagDraftAt("朝ラン #ru", 10)).toBe("ru");
  });

  it("reports an empty draft right after the hash", () => {
    expect(tagDraftAt("朝ラン #", 8)).toBe("");
  });

  it("is null when the caret is not inside a tag", () => {
    expect(tagDraftAt("朝ラン #run した", 14)).toBeNull();
    expect(tagDraftAt("ただの本文", 5)).toBeNull();
  });

  // Completion opening in the middle of a URL gets in the way while typing.
  it("is null when the hash is not at a word boundary", () => {
    expect(tagDraftAt("https://x.com/a#fr", 18)).toBeNull();
  });

  it("opens right after japanese punctuation", () => {
    expect(tagDraftAt("走った。#ru", 10)).toBe("ru");
  });
});

describe("matchTagPrefix", () => {
  const known = [
    { tag: "sync", count: 3 },
    { tag: "syntax", count: 1 },
    { tag: "design", count: 2 },
  ];

  it("keeps the frequency order while filtering", () => {
    expect(matchTagPrefix(known, "syn").map((t) => t.tag)).toStrictEqual(["sync", "syntax"]);
  });

  it("returns everything for an empty draft", () => {
    expect(matchTagPrefix(known, "")).toHaveLength(3);
  });

  it("ignores case", () => {
    expect(matchTagPrefix(known, "SYN").map((t) => t.tag)).toStrictEqual(["sync", "syntax"]);
  });

  // A candidate keeps the spelling as typed, so without folding both sides no completion appears
  it("ignores case on the known tag too", () => {
    expect(
      matchTagPrefix([{ tag: "CognitiveBias", count: 1 }], "cog").map((t) => t.tag),
    ).toStrictEqual(["CognitiveBias"]);
  });

  it("returns nothing when no tag starts with the draft", () => {
    expect(matchTagPrefix(known, "zzz")).toStrictEqual([]);
  });
});

describe("suggestTags", () => {
  const known = [
    { tag: "work", count: 9 },
    { tag: "homework", count: 5 },
    { tag: "Worklog", count: 3 },
    { tag: "run", count: 2 },
  ];

  it("offers the most used tags while nothing is typed", () => {
    expect(suggestTags(known, [], "", 2).map((t) => t.tag)).toStrictEqual(["work", "homework"]);
  });

  // "work" inside "homework" still counts, but a tag that starts with it is what was meant
  it("puts a prefix match ahead of a tag that only contains the query", () => {
    expect(suggestTags(known, [], "WORK", 5).map((t) => t.tag)).toStrictEqual([
      "work",
      "Worklog",
      "homework",
    ]);
  });

  it("leaves out the tags the note already carries, whatever their case", () => {
    expect(suggestTags(known, ["Work"], "work", 5).map((t) => t.tag)).toStrictEqual([
      "Worklog",
      "homework",
    ]);
  });
});

describe("isNewTag", () => {
  const known = [{ tag: "Memo", count: 1 }];

  it("offers a word nobody has used as a new tag", () => {
    expect(isNewTag(known, [], "#idea")).toBe(true);
  });

  it("does not offer a second spelling of a tag in use", () => {
    expect(isNewTag(known, [], "memo")).toBe(false);
  });

  it("does not offer an empty word or one the note already has", () => {
    expect(isNewTag(known, [], "  ")).toBe(false);
    expect(isNewTag(known, ["idea"], "Idea")).toBe(false);
  });
});
