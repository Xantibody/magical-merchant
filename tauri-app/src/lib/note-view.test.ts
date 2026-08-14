import { describe, expect, it } from "vitest";
import { resolveNoteView, toggledView, viewToFrontmatter } from "./note-view";

describe("resolveNoteView", () => {
  it("view キーが無いノートはエディタ表示", () => {
    expect(resolveNoteView()).toBe("editor");
  });

  it("mindmap はマインドマップ表示", () => {
    expect(resolveNoteView("mindmap")).toBe("mindmap");
  });

  it("知らない値はエディタ表示に倒す(新しい版のアプリが書いたノートかもしれない)", () => {
    expect(resolveNoteView("kanban")).toBe("editor");
  });
});

describe("toggledView", () => {
  it("エディタ ⇄ マインドマップを往復する", () => {
    expect(toggledView("editor")).toBe("mindmap");
    expect(toggledView("mindmap")).toBe("editor");
  });
});

describe("viewToFrontmatter", () => {
  it("既定のエディタ表示は null(キーを書かない)", () => {
    expect(viewToFrontmatter("editor")).toBeNull();
  });

  it("マインドマップは mindmap を書く", () => {
    expect(viewToFrontmatter("mindmap")).toBe("mindmap");
  });
});
