import { describe, it, expect } from "vitest";
import { noteLinkFile, splitNoteLinks } from "./note-link";

describe("splitNoteLinks", () => {
  it("returns the whole text when there is no link", () => {
    expect(splitNoteLinks("ただの本文")).toStrictEqual([
      { text: "ただの本文", id: null, alias: null },
    ]);
  });

  it("splits text around a link", () => {
    expect(splitNoteLinks("前 [[20260813_083000]] 後")).toStrictEqual([
      { text: "前 ", id: null, alias: null },
      { text: "[[20260813_083000]]", id: "20260813_083000", alias: null },
      { text: " 後", id: null, alias: null },
    ]);
  });

  it("finds every link in the text", () => {
    const segments = splitNoteLinks("[[20260813_083000]][[20260810_090000]]");
    expect(segments.map((s) => s.id)).toStrictEqual(["20260813_083000", "20260810_090000"]);
  });

  // A filename is fixed as a zero-padded datetime. Any other `[[...]]` is the user's own
  // body text and must not turn into a link
  it("leaves non-filename brackets alone", () => {
    expect(splitNoteLinks("[[wiki 風のメモ]]")).toStrictEqual([
      { text: "[[wiki 風のメモ]]", id: null, alias: null },
    ]);
  });

  it("reads the display text after the pipe", () => {
    expect(splitNoteLinks("[[20260813_083000|前の話]]")).toStrictEqual([
      { text: "[[20260813_083000|前の話]]", id: "20260813_083000", alias: "前の話" },
    ]);
  });

  // `[[ID|]]` is the halfway state after the display text was deleted. Let it resolve to the title
  it("treats an empty display text as absent", () => {
    expect(splitNoteLinks("[[20260813_083000|]]")[0].alias).toBeNull();
  });
});

describe("noteLinkFile", () => {
  it("turns a link id into the note filename", () => {
    expect(noteLinkFile("20260813_083000")).toBe("20260813_083000.md");
  });
});
