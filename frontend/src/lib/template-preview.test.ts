import { describe, expect, it } from "vitest";
import { previewBlocks } from "./template-preview";

describe("previewBlocks", () => {
  it("reads headings, tasks, bullets and paragraphs, a line at a time", () => {
    expect(
      previewBlocks("# 日次\n\n## やること\n- [ ] 洗濯\n- [x] 掃除\n- 買い物\n前回: x"),
    ).toStrictEqual([
      { kind: "heading", level: 1, text: "日次" },
      { kind: "heading", level: 2, text: "やること" },
      { kind: "task", done: false, text: "洗濯" },
      { kind: "task", done: true, text: "掃除" },
      { kind: "bullet", text: "買い物" },
      { kind: "paragraph", text: "前回: x" },
    ]);
  });

  // Deeper headings are drawn like the second level; the preview is a sketch, not the note
  it("folds deeper headings into the second level", () => {
    expect(previewBlocks("### 1. 状況")).toStrictEqual([
      { kind: "heading", level: 2, text: "1. 状況" },
    ]);
  });

  it("keeps an empty task as a box with no text", () => {
    expect(previewBlocks("- [ ] ")).toStrictEqual([{ kind: "task", done: false, text: "" }]);
  });
});
