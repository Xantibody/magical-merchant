import { describe, it, expect } from "vitest";
import { blockMark, diffLineCounts, markLines, markedBody } from "./diff-marks";

describe("markLines", () => {
  it("leaves the draft untouched when the diff is empty", () => {
    expect(markLines("a\nb", "")).toStrictEqual({ source: "a\nb", marks: [undefined, undefined] });
  });

  // core's unified diff (three lines of context either side). A deleted line goes back to
  // its place in the draft, and an added line stays as it is
  it("puts deleted lines back where they were and marks added ones", () => {
    const draft = "a\nB\nc\nd\n";
    const diff = "--- v1\n+++ draft\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+d\n";

    expect(markLines(draft, diff)).toStrictEqual({
      source: "a\nb\nB\nc\nd",
      marks: [undefined, "del", "add", undefined, "add"],
    });
  });

  // Lines outside the context do not appear in the diff. They are filled in from the draft
  it("fills the lines outside every hunk from the draft", () => {
    const draft = ["1", "2", "3", "4", "5", "6", "six", "7", "8", "9"].join("\n");
    const diff = "--- v\n+++ draft\n@@ -5,3 +5,4 @@\n 5\n 6\n+six\n 7\n";

    const marked = markLines(draft, diff);

    expect(marked.source).toBe(draft);
    expect(marked.marks[6]).toBe("add");
    expect(marked.marks.filter(Boolean)).toHaveLength(1);
  });

  it("handles a hunk that only deletes, and a hunk of one line", () => {
    // `+2,0` means "after line 2". `@@ -1 +1 @@` is one line with the length left out
    const removed = markLines("a\nb", "--- v\n+++ draft\n@@ -3,1 +2,0 @@\n-c\n");
    expect(removed).toStrictEqual({ source: "a\nb\nc", marks: [undefined, undefined, "del"] });

    const one = markLines("B", "--- v\n+++ draft\n@@ -1 +1 @@\n-A\n+B\n");
    expect(one).toStrictEqual({ source: "A\nB", marks: ["del", "add"] });
  });

  // When a rule is added at the head of a Codex with no title, the first body line begins
  // with `+---`. The header only ever sits before the first hunk
  it("keeps a first line that spells like a header once the hunk has begun", () => {
    const diff = "--- v\n+++ draft\n@@ -0,0 +1,2 @@\n+---\n+++x\n";

    expect(markLines("---\n++x", diff)).toStrictEqual({
      source: "---\n++x",
      marks: ["add", "add"],
    });
  });

  it("ignores the missing-newline hint and body lines that look like headers", () => {
    const diff =
      "--- v\n+++ draft\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+--- dash\n";

    expect(markLines("a\n--- dash", diff)).toStrictEqual({
      source: "a\nb\n--- dash",
      marks: [undefined, "del", "add"],
    });
  });
});

describe("markedBody", () => {
  it("drops the title line the title field already shows", () => {
    const diff = "--- v\n+++ draft\n@@ -1,3 +1,3 @@\n # 題\n \n-古い\n+新しい\n";

    expect(markedBody("# 題\n\n新しい", diff)).toStrictEqual({
      source: "古い\n新しい",
      marks: ["del", "add"],
    });
  });

  // When the title changes, the old title comes first as a deleted line. That is taken
  // out, and the new title is kept as a marked H1
  it("keeps a changed title visible as an added heading", () => {
    const diff = "--- v\n+++ draft\n@@ -1,3 +1,3 @@\n-# 前\n+# 後\n \n 本文\n";

    expect(markedBody("# 後\n\n本文", diff)).toStrictEqual({
      source: "# 後\n\n本文",
      marks: ["add", undefined, undefined],
    });
  });

  it("leaves a body without a title alone", () => {
    expect(markedBody("本文", "")).toStrictEqual({ source: "本文", marks: [undefined] });
  });
});

describe("diffLineCounts", () => {
  it("counts nothing when the version and the draft are the same", () => {
    expect(diffLineCounts("")).toStrictEqual({ added: 0, removed: 0 });
  });

  it("counts the lines the draft gained and lost", () => {
    const diff = "--- v1\n+++ draft\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+d\n";

    expect(diffLineCounts(diff)).toStrictEqual({ added: 2, removed: 1 });
  });

  // The `---` / `+++` of the header are not lines. A `+---` inside a hunk is a line
  it("does not count the header, and does count body lines spelled like it", () => {
    const diff = "--- v\n+++ draft\n@@ -0,0 +1,2 @@\n+---\n+++x\n";

    expect(diffLineCounts(diff)).toStrictEqual({ added: 2, removed: 0 });
  });

  it("ignores the missing-newline hint", () => {
    const diff = "--- v\n+++ draft\n@@ -1,2 +1,1 @@\n a\n-b\n\\ No newline at end of file\n";

    expect(diffLineCounts(diff)).toStrictEqual({ added: 0, removed: 1 });
  });
});

describe("blockMark", () => {
  it("is del only when every line of the block went away", () => {
    expect(blockMark(["del", "del"], 0, 2)).toBe("del");
    expect(blockMark(["del", undefined], 0, 2)).toBe("add");
    expect(blockMark([undefined, "add"], 0, 2)).toBe("add");
    expect(blockMark([undefined, undefined], 0, 2)).toBeUndefined();
    expect(blockMark(["del"], 1, 1)).toBeUndefined();
  });
});
