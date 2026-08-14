import { NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
import type { Command } from "@milkdown/kit/prose/state";

/**
 * カーソルのあるブロックを丸ごと消す。キーボードだけなら範囲選択して消せるが、
 * スマホではコードブロックの全選択も水平線の選択も現実的にできないため、
 * ツールバーの入口として用意する。
 *
 * - 水平線などを選んだ NodeSelection はその選択を消す
 * - コードブロック・段落はブロックごと消す。リスト項目の唯一の段落なら
 *   `deleteRange` が項目ごと畳んでくれる
 * - 最後の 1 ブロックは消すと文書が空になれないので、空の段落に置き換える
 */
export const deleteCurrentBlock: Command = (state, dispatch) => {
  const { selection, tr } = state;

  if (selection instanceof NodeSelection) {
    tr.deleteSelection();
  } else {
    const { $from } = selection;
    if ($from.depth === 0) {
      return false;
    }
    const from = $from.before($from.depth);
    const to = $from.after($from.depth);
    if (from === 0 && to === state.doc.content.size) {
      tr.replaceWith(from, to, state.schema.nodes.paragraph.create());
      tr.setSelection(TextSelection.create(tr.doc, 1));
    } else {
      tr.deleteRange(from, to);
    }
  }

  dispatch?.(tr.scrollIntoView());
  return true;
};

/**
 * コードブロックの直後に段落を作ってカーソルを移す。キーボードでは
 * Mod-Enter に割り当てているが、スマホには修飾キーがないので
 * ツールバーからも同じコマンドを呼べるようにしておく。
 */
export const exitCodeBlock: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.parent.type.name !== "code_block") {
    return false;
  }
  if (!dispatch) {
    return true;
  }

  const endOfBlock = $from.after($from.depth);
  const { tr } = state;
  tr.insert(endOfBlock, state.schema.nodes.paragraph.create());
  tr.setSelection(TextSelection.near(tr.doc.resolve(endOfBlock + 1)));
  dispatch(tr.scrollIntoView());
  return true;
};
