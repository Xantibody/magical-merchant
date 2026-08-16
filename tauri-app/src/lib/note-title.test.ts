import { describe, it, expect } from "vitest";
import { joinTitle, splitTitle } from "./note-title";

describe("splitTitle", () => {
  it("takes the leading h1 as the title", () => {
    expect(splitTitle("# 設計メモ\n\n本文")).toStrictEqual({ title: "設計メモ", body: "本文" });
  });

  it("keeps a body that does not start with a heading", () => {
    // タイムラインから昇格したノートは本文で始まる。地の文を勝手に
    // 見出しへ格上げすると、次の保存で本文が書き換わってしまう
    expect(splitTitle("走った。#run\n続き")).toStrictEqual({
      title: "",
      body: "走った。#run\n続き",
    });
  });

  it("leaves a lower heading in the body", () => {
    expect(splitTitle("## 小見出し\n本文")).toStrictEqual({ title: "", body: "## 小見出し\n本文" });
  });

  // `#タグ` は見出しではない。`# ` の空白まで含めて見出しと決める
  it("does not read a tag as a title", () => {
    expect(splitTitle("#sync を直す")).toStrictEqual({ title: "", body: "#sync を直す" });
  });

  it("keeps a later h1 in the body", () => {
    expect(splitTitle("本文\n# 後ろの見出し")).toStrictEqual({
      title: "",
      body: "本文\n# 後ろの見出し",
    });
  });

  it("reads a title-only note", () => {
    expect(splitTitle("# 題だけ")).toStrictEqual({ title: "題だけ", body: "" });
  });

  it("returns empties for an empty note", () => {
    expect(splitTitle("")).toStrictEqual({ title: "", body: "" });
  });
});

describe("joinTitle", () => {
  it("writes the title back as the leading h1", () => {
    expect(joinTitle("設計メモ", "本文")).toBe("# 設計メモ\n\n本文");
  });

  // 空の見出しを残すと、一覧のタイトルが「#」だけの行になる
  it("writes no heading when the title is empty", () => {
    expect(joinTitle("", "本文")).toBe("本文");
    expect(joinTitle("   ", "本文")).toBe("本文");
  });

  it("writes a title without a body", () => {
    expect(joinTitle("題だけ", "")).toBe("# 題だけ\n");
  });

  it("round-trips what splitTitle produced", () => {
    const source = "# 設計メモ\n\n本文\n\n## 節";
    const { title, body } = splitTitle(source);
    expect(joinTitle(title, body)).toBe(source);
  });
});
