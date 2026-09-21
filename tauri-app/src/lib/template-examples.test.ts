import { describe, expect, it } from "vitest";
import { dropExamples, extractExamples } from "./template-examples";

describe("dropExamples", () => {
  /** 書き出す core (`template/vars.rs`) と同じ姿にする。 */
  it("leaves the note the way the core writes it", () => {
    expect(dropExamples("### 状況\n{{eg}}\n- 問い\n- もう一つ\n\n### 影響")).toBe(
      "### 状況\n\n### 影響",
    );
  });

  it("keeps a body that has no examples", () => {
    const body = "# {{date}}\n\n- \n\n{{prev}}";
    expect(dropExamples(body)).toBe(body);
  });
});

describe("extractExamples", () => {
  it("collects the block under a heading", () => {
    const examples = extractExamples(
      "### 1. 状況（Context）\n{{eg}}\n- 本来の方向性は?\n- どんなズレがあったか?\n\n### 2. 影響",
    );
    expect(examples.get("1. 状況（Context）")).toStrictEqual([
      "本来の方向性は?",
      "どんなズレがあったか?",
    ]);
  });

  it("ends the block at the next heading", () => {
    const examples = extractExamples("### 状況\n{{eg}}\n- 問い\n### 影響\n{{eg}}\n- 別の問い");
    expect(examples.get("状況")).toStrictEqual(["問い"]);
    expect(examples.get("影響")).toStrictEqual(["別の問い"]);
  });

  it("ends the block at the end of the body", () => {
    expect(extractExamples("### 状況\n{{eg}}\n- 問い").get("状況")).toStrictEqual(["問い"]);
  });

  it("keeps a block written before any heading under the empty key", () => {
    expect(extractExamples("{{eg}}\n今日の一行\n\n### 状況").get("")).toStrictEqual(["今日の一行"]);
  });

  it("strips the list marker but not the words", () => {
    const examples = extractExamples("# 見出し\n{{eg}}\n- 箇条書き\n* 星\n1. 番号\n素の行");
    expect(examples.get("見出し")).toStrictEqual(["箇条書き", "星", "番号", "素の行"]);
  });

  it("takes a one-line example written in the marker itself", () => {
    expect(extractExamples("# 見出し\n{{eg: 一行の例}}\n\n本文").get("見出し")).toStrictEqual([
      "一行の例",
    ]);
  });

  it("ignores an {{eg}} written in the middle of a line", () => {
    expect(extractExamples("# 見出し\n例: {{eg}} と書く\n- 問い").size).toBe(0);
  });

  it("has nothing to say about a template without examples", () => {
    expect(extractExamples("# {{date}}\n\n- \n\n{{prev}}").size).toBe(0);
  });

  it("keeps the last block when a heading is written twice", () => {
    const examples = extractExamples("# 同じ\n{{eg}}\n- 先\n\n# 同じ\n{{eg}}\n- 後");
    expect(examples.get("同じ")).toStrictEqual(["後"]);
  });
});
