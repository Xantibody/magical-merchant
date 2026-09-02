import { describe, it, expect } from "vitest";
import { Schema } from "@milkdown/kit/prose/model";
import { activeCodeBlockRanges } from "./active-code-block";

// milkdown の schema はエディタ ctx がないと組めないので、位置計算に必要な
// 形だけの最小 schema で文書を作る(判定は node type 名しか見ない)
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*" },
    code_block: { group: "block", content: "text*", code: true },
    blockquote: { group: "block", content: "block+" },
    text: {},
  },
});

// 位置: paragraph "hello" = [0,7)、code_block "graph TD;" = [7,18)
const doc = schema.node("doc", null, [
  schema.node("paragraph", null, [schema.text("hello")]),
  schema.node("code_block", null, [schema.text("graph TD;")]),
]);

describe("activeCodeBlockRanges", () => {
  it("returns the enclosing block for a cursor inside it", () => {
    expect(activeCodeBlockRanges(doc, 10, 10)).toStrictEqual([{ from: 7, to: 18 }]);
  });

  it("returns nothing for a cursor outside every code block", () => {
    expect(activeCodeBlockRanges(doc, 2, 2)).toStrictEqual([]);
  });

  it("includes a block the selection only partially covers", () => {
    expect(activeCodeBlockRanges(doc, 2, 10)).toStrictEqual([{ from: 7, to: 18 }]);
  });

  it("returns every block inside a wide selection", () => {
    const two = schema.node("doc", null, [
      schema.node("code_block", null, [schema.text("a")]),
      schema.node("paragraph", null, [schema.text("x")]),
      schema.node("code_block", null, [schema.text("b")]),
    ]);
    // code_block "a" = [0,3)、paragraph = [3,6)、code_block "b" = [6,9)
    expect(activeCodeBlockRanges(two, 0, two.content.size)).toStrictEqual([
      { from: 0, to: 3 },
      { from: 6, to: 9 },
    ]);
  });

  // blockquote 内の code_block も編集対象。入れ子でも見つける
  it("finds a block nested inside another node", () => {
    const nested = schema.node("doc", null, [
      schema.node("blockquote", null, [schema.node("code_block", null, [schema.text("a")])]),
    ]);
    // blockquote = [0,5)、code_block "a" = [1,4)
    expect(activeCodeBlockRanges(nested, 2, 2)).toStrictEqual([{ from: 1, to: 4 }]);
  });
});
