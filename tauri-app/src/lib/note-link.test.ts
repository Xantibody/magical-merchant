import { describe, it, expect } from "vitest";
import { noteLinkFile, splitNoteLinks } from "./note-link";

describe("splitNoteLinks", () => {
  it("returns the whole text when there is no link", () => {
    expect(splitNoteLinks("ただの本文")).toEqual([{ text: "ただの本文", id: null, alias: null }]);
  });

  it("splits text around a link", () => {
    expect(splitNoteLinks("前 [[20260813_083000]] 後")).toEqual([
      { text: "前 ", id: null, alias: null },
      { text: "[[20260813_083000]]", id: "20260813_083000", alias: null },
      { text: " 後", id: null, alias: null },
    ]);
  });

  it("finds every link in the text", () => {
    const segments = splitNoteLinks("[[20260813_083000]][[20260810_090000]]");
    expect(segments.map((s) => s.id)).toEqual(["20260813_083000", "20260810_090000"]);
  });

  // ファイル名はゼロ埋めの日時と決まっている。それ以外の [[...]] は
  // ユーザーの本文であって、リンクに化けてはいけない
  it("leaves non-filename brackets alone", () => {
    expect(splitNoteLinks("[[wiki 風のメモ]]")).toEqual([
      { text: "[[wiki 風のメモ]]", id: null, alias: null },
    ]);
  });

  it("reads the display text after the pipe", () => {
    expect(splitNoteLinks("[[20260813_083000|前の話]]")).toEqual([
      { text: "[[20260813_083000|前の話]]", id: "20260813_083000", alias: "前の話" },
    ]);
  });

  // `[[ID|]]` は表示文字を消した途中の状態。タイトルに解決させる
  it("treats an empty display text as absent", () => {
    expect(splitNoteLinks("[[20260813_083000|]]")[0].alias).toBeNull();
  });
});

describe("noteLinkFile", () => {
  it("turns a link id into the note filename", () => {
    expect(noteLinkFile("20260813_083000")).toBe("20260813_083000.md");
  });
});
