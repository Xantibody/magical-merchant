import { describe, it, expect } from "vitest";
import {
  countTagLists,
  countTags,
  matchTagPrefix,
  parseTags,
  splitTagged,
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

  // `# ` で始まる行は見出し。タグとして数えるとほぼ全ノートに付いてしまう。
  it("ignores a markdown heading", () => {
    expect(parseTags("# 見出し\n本文")).toStrictEqual([]);
  });

  it("ignores a hash that is not at a word boundary", () => {
    expect(parseTags("https://example.com/a#frag")).toStrictEqual([]);
    expect(parseTags("C#")).toStrictEqual([]);
  });

  // core の tags.rs と同じ約束。打った綴りをそのまま返す
  it("keeps the spelling a tag was written with", () => {
    expect(parseTags("#CognitiveBias を疑う")).toStrictEqual(["CognitiveBias"]);
  });

  // 別々に数えると同じ分類が二重に並ぶ。残すのは最初に見た綴り
  it("folds case when deduping and keeps the first spelling", () => {
    expect(parseTags("#Rust と #rust と #RUST")).toStrictEqual(["Rust"]);
  });

  it("keeps japanese tags as written", () => {
    expect(parseTags("#設計 #カタカナ")).toStrictEqual(["設計", "カタカナ"]);
  });

  it("finds a tag at the start of a later line", () => {
    expect(parseTags("一行目\n#二行目")).toStrictEqual(["二行目"]);
  });

  // 日本語は語の間に空白を置かない。句点の直後を拾えないとほとんど落ちる。
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

  // 同じ本文に 2 回書いても、その本文が 1 件であることは変わらない。
  it("counts a tag once per text", () => {
    expect(countTags(["#a と #a"])).toStrictEqual([{ tag: "a", count: 1 }]);
  });

  it("breaks ties by name so the order does not wander", () => {
    expect(countTags(["#b #a"]).map((t) => t.tag)).toStrictEqual(["a", "b"]);
  });

  // チップが 2 つに割れると、同じ分類を 2 回押し分けることになる
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

  // frontmatter は書かれたまま残るので、1 件が両方の綴りを名乗ることがある
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

  // URL の途中で補完が開くと、打っている最中に邪魔になる。
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

  // 候補の綴りは打った形のまま残るので、両側を畳まないと補完が出ない
  it("ignores case on the known tag too", () => {
    expect(
      matchTagPrefix([{ tag: "CognitiveBias", count: 1 }], "cog").map((t) => t.tag),
    ).toStrictEqual(["CognitiveBias"]);
  });

  it("returns nothing when no tag starts with the draft", () => {
    expect(matchTagPrefix(known, "zzz")).toStrictEqual([]);
  });
});
