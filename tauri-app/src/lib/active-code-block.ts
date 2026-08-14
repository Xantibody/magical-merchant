import type { Node } from "@milkdown/kit/prose/model";

export interface NodeRange {
  from: number;
  to: number;
}

/**
 * 選択範囲 [from, to] に触れている code_block のノード範囲を集める。
 * mermaid ブロックの「カーソルが中にある間だけソースを見せる」判定に使う。
 * カーソル(from === to)が中にあるブロックも、選択が部分的にかすった
 * ブロックも「触れている」として扱う。
 */
export function activeCodeBlockRanges(doc: Node, from: number, to: number): NodeRange[] {
  const ranges: NodeRange[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name !== "code_block") {
      return true;
    }
    ranges.push({ from: pos, to: pos + node.nodeSize });
    return false;
  });
  return ranges;
}
