import { describe, expect, it } from "vitest";
import { outlineToTree } from "./mindmap";

function contents(nodes: { content: string }[]): string[] {
  return nodes.map((n) => n.content);
}

describe("outlineToTree", () => {
  it("空の本文は空のルートになる", () => {
    expect(outlineToTree("")).toEqual({ content: "", children: [] });
  });

  it("ただ 1 つの見出しはルートに昇格する", () => {
    const root = outlineToTree("# 計画");
    expect(root.content).toBe("計画");
    expect(root.children).toEqual([]);
  });

  it("見出しの下のリストが枝になる", () => {
    const root = outlineToTree(["# 計画", "- 買い出し", "- 仕込み"].join("\n"));
    expect(root.content).toBe("計画");
    expect(contents(root.children)).toEqual(["買い出し", "仕込み"]);
  });

  it("リストの入れ子は枝の入れ子になる", () => {
    const root = outlineToTree(["# 計画", "- 買い出し", "  - 野菜", "  - 肉"].join("\n"));
    const [item] = root.children;
    expect(item.content).toBe("買い出し");
    expect(contents(item.children)).toEqual(["野菜", "肉"]);
  });

  /**
   * markmap-lib はこの形でリストを捨てる(見出しとリストが同じ親の下に並ぶと
   * 見出しだけが残る)。ノートは「H1 と `-` の混在」が普通なので、両方を保つ。
   */
  it("同じ見出しの下でリストと小見出しが共存する", () => {
    const root = outlineToTree(["# 計画", "- 買い出し", "## 当日", "- 集合"].join("\n"));
    expect(root.content).toBe("計画");
    expect(contents(root.children)).toEqual(["買い出し", "当日"]);
    expect(contents(root.children[1].children)).toEqual(["集合"]);
  });

  it("見出しの階層が枝の階層になる", () => {
    const root = outlineToTree(["# A", "## B", "### C", "## D"].join("\n"));
    expect(root.content).toBe("A");
    expect(contents(root.children)).toEqual(["B", "D"]);
    expect(contents(root.children[0].children)).toEqual(["C"]);
  });

  it("トップレベルが複数あるときは空のルートでまとめる", () => {
    const root = outlineToTree(["# A", "# B"].join("\n"));
    expect(root.content).toBe("");
    expect(contents(root.children)).toEqual(["A", "B"]);
  });

  it("階層を飛ばした見出し(H1 の次に H3)も直近の親につく", () => {
    const root = outlineToTree(["# A", "### C"].join("\n"));
    expect(contents(root.children)).toEqual(["C"]);
  });

  it("リスト項目の段落以外(本文の地の文)は構造に含めない", () => {
    const root = outlineToTree(["# 計画", "地の文の段落。", "- 買い出し"].join("\n"));
    expect(contents(root.children)).toEqual(["買い出し"]);
  });

  it("強調などのインライン記法は HTML として保つ", () => {
    const root = outlineToTree("# **大事**な計画");
    expect(root.content).toBe("<strong>大事</strong>な計画");
  });

  it("生の HTML はエスケープされる(同期で降ってきたノートかもしれない)", () => {
    const root = outlineToTree("# <script>alert(1)</script>");
    expect(root.content).not.toContain("<script>");
  });
});
