import type { Node } from "@milkdown/kit/prose/model";

export interface NodeRange {
  from: number;
  to: number;
}

/**
 * Collect the node ranges of the code_block nodes that touch the selection [from, to].
 * Used by the mermaid block to decide "show the source only while the cursor is inside".
 * A block holding the cursor (from === to) and a block the selection only partly grazes
 * both count as touched.
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
