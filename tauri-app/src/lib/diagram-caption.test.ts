import { describe, it, expect } from "vitest";
import { extractCaption } from "./diagram-caption";

describe("extractCaption", () => {
  it("reads the caption from the leading comment", () => {
    const source = ["%% caption: 図1 — 同期の全体フロー", "flowchart TD", "  A --> B"].join("\n");

    expect(extractCaption(source)).toBe("図1 — 同期の全体フロー");
  });

  it("skips the blank lines before the comment", () => {
    const source = ["", "  ", "%% caption: 図2", "flowchart TD"].join("\n");

    expect(extractCaption(source)).toBe("図2");
  });

  it("trims the space around the caption", () => {
    expect(extractCaption("%%   caption:   図3   \nflowchart TD")).toBe("図3");
  });

  it("finds no caption in a diagram that has none", () => {
    expect(extractCaption("flowchart TD\n  A --> B")).toBeUndefined();
  });

  // mermaid のコメントは caption 専用ではない。他のコメントを拾うと、
  // 設定や覚書がそのまま図の説明として出てしまう
  it("ignores a comment that is not a caption", () => {
    expect(extractCaption("%% theme を上書きする\nflowchart TD")).toBeUndefined();
  });

  // 先頭に限るのは、図の途中のコメントを説明文として引き上げないため
  it("ignores a caption comment that is not the first line", () => {
    expect(extractCaption("flowchart TD\n%% caption: 図4")).toBeUndefined();
  });

  it("finds no caption when the comment has no text", () => {
    expect(extractCaption("%% caption:   \nflowchart TD")).toBeUndefined();
  });

  it("finds no caption in an empty diagram", () => {
    expect(extractCaption("")).toBeUndefined();
  });
});
