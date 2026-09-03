import { describe, expect, it } from "vitest";
import { nextView, readNoteContent, resolveNoteView, viewToFrontmatter } from "./note-view";

describe("resolveNoteView", () => {
  it("view キーが無いノートはエディタ表示", () => {
    expect(resolveNoteView()).toBe("editor");
  });

  it("mindmap はマインドマップ表示", () => {
    expect(resolveNoteView("mindmap")).toBe("mindmap");
  });

  it("preview は読むだけの表示", () => {
    expect(resolveNoteView("preview")).toBe("preview");
  });

  it("知らない値はエディタ表示に倒す(新しい版のアプリが書いたノートかもしれない)", () => {
    expect(resolveNoteView("kanban")).toBe("editor");
  });
});

describe("nextView", () => {
  it("ボタン 1 つで エディタ → マインドマップ → プレビュー と一巡する", () => {
    expect(nextView("editor")).toBe("mindmap");
    expect(nextView("mindmap")).toBe("preview");
    expect(nextView("preview")).toBe("editor");
  });
});

describe("readNoteContent", () => {
  it("本文と表示モードを一度に返す(別々に届くと一瞬違うモードで描かれる)", async () => {
    const content = await readNoteContent(
      () => Promise.resolve({ body: "# 見取り図", revision: "r1" }),
      () => Promise.resolve({ view: "mindmap" }),
    );
    expect(content).toStrictEqual({ body: "# 見取り図", view: "mindmap", revision: "r1" });
  });

  it("preview のノートは読むだけの表示で開く", async () => {
    const content = await readNoteContent(
      () => Promise.resolve({ body: "# 読み物", revision: "r2" }),
      () => Promise.resolve({ view: "preview" }),
    );
    expect(content).toStrictEqual({ body: "# 読み物", view: "preview", revision: "r2" });
  });

  it("メタが読めないノートはエディタ表示で開く", async () => {
    const content = await readNoteContent(
      () => Promise.resolve({ body: "body", revision: "r1" }),
      () => Promise.reject(new Error("broken frontmatter")),
    );
    expect(content).toStrictEqual({ body: "body", view: "editor", revision: "r1" });
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

  it("プレビューは preview を書く", () => {
    expect(viewToFrontmatter("preview")).toBe("preview");
  });
});
