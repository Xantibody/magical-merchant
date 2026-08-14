import { describe, expect, it } from "vitest";
import { readNoteContent, resolveNoteView, toggledView, viewToFrontmatter } from "./note-view";

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

describe("readNoteContent", () => {
  it("本文と表示モードを一度に返す(別々に届くと一瞬違うモードで描かれる)", async () => {
    const content = await readNoteContent(
      () => Promise.resolve("# 見取り図"),
      () => Promise.resolve({ view: "mindmap" }),
    );
    expect(content).toEqual({ body: "# 見取り図", view: "mindmap" });
  });

  it("メタが読めないノートはエディタ表示で開く", async () => {
    const content = await readNoteContent(
      () => Promise.resolve("body"),
      () => Promise.reject(new Error("broken frontmatter")),
    );
    expect(content).toEqual({ body: "body", view: "editor" });
  });

  it("本文が読めなければ失敗はそのまま伝える", async () => {
    await expect(
      readNoteContent(
        () => Promise.reject(new Error("missing note")),
        () => Promise.resolve({}),
      ),
    ).rejects.toThrow("missing note");
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
