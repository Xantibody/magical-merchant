import { bulletListSchema } from "@milkdown/kit/preset/commonmark";
import { InputRule } from "@milkdown/kit/prose/inputrules";
import type { Node } from "@milkdown/kit/prose/model";
import type { Transaction } from "@milkdown/kit/prose/state";
import { canJoin, findWrapping } from "@milkdown/kit/prose/transform";
import { $inputRule } from "@milkdown/kit/utils";

function isEmptyParagraph(node: Node): boolean {
  return node.type.name === "paragraph" && node.content.size === 0;
}

/** Deletes the empty paragraphs between the block at `pos` and a list of `listType` above them. */
function closeGapToList(tr: Transaction, pos: number, listType: Node["type"]): void {
  const $pos = tr.doc.resolve(pos);
  const depth = $pos.depth - 1;
  const parent = $pos.node(depth);
  const index = $pos.index(depth);
  let first = index;
  while (first > 0 && isEmptyParagraph(parent.child(first - 1))) {
    first -= 1;
  }
  if (first < index && first > 0 && parent.child(first - 1).type === listType) {
    tr.delete($pos.posAtIndex(first, depth), $pos.before());
  }
}

/**
 * `- `, `+ ` or `* ` at the start of a block makes it a bullet list, joined to the list above.
 *
 * Replaces Milkdown's rule, which is prosemirror's wrappingInputRule: it joins only a list
 * directly above, so after a blank line the item began a list of its own and Tab could not
 * indent it under the item before. Here the empty paragraphs in between go first.
 */
export const bulletListInputRule = $inputRule(
  (ctx) =>
    new InputRule(/^\s*[-+*]\s$/u, (state, _match, start, end) => {
      const listType = bulletListSchema.type(ctx);
      const { tr } = state;
      closeGapToList(tr, start, listType);
      const from = tr.mapping.map(start);
      tr.delete(from, tr.mapping.map(end));
      const range = tr.doc.resolve(from).blockRange();
      const wrapping = range && findWrapping(range, listType);
      if (!range || !wrapping) {
        return null;
      }
      tr.wrap(range, wrapping);
      const before = tr.doc.resolve(from - 1).nodeBefore;
      if (before?.type === listType && canJoin(tr.doc, from - 1)) {
        tr.join(from - 1);
      }
      return tr;
    }),
);
