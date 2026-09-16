import { NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
import type { Command, EditorState, Transaction } from "@milkdown/kit/prose/state";

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

const CODE_INDENT = "  ";

/**
 * コードブロックの中の Tab は字下げ。ProseMirror は Tab を扱わないので、
 * 素通しにするとブラウザがフォーカスを次の要素へ移し、書きかけの手が
 * エディタの外に落ちる。2 スペースなのは、Markdown のコードブロックで
 * 一番ありふれた幅だから(タブ文字は表示幅が環境で変わる)。
 */
export const indentCodeLine: Command = (state, dispatch) => {
  if (state.selection.$from.parent.type.name !== "code_block") {
    return false;
  }
  dispatch?.(state.tr.insertText(CODE_INDENT).scrollIntoView());
  return true;
};

/**
 * コードブロックの中の Shift-Tab は行頭の字下げを一段戻す。戻すものが
 * なくても受けたことにするのは、フォーカスを外へ逃がさないため。
 */
export const outdentCodeLine: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.parent.type.name !== "code_block") {
    return false;
  }
  const text = $from.parent.textContent;
  const lineStart = text.lastIndexOf("\n", $from.parentOffset - 1) + 1;
  const indent = /^(?: {1,2}|\t)/u.exec(text.slice(lineStart))?.[0];
  if (indent && dispatch) {
    const from = $from.start() + lineStart;
    dispatch(state.tr.delete(from, from + indent.length).scrollIntoView());
  }
  return true;
};

/**
 * 入力ルールが `---` を水平線に置き換えたあと、カーソルを罫線の下の新しい
 * 段落へ置く。Milkdown の insertHrInputRule は置き換えるだけで選択を決めず、
 * 罫線そのものが選ばれた(NodeSelection の)状態で終わる。そこで次の文字を
 * 打つと罫線が消える。返すのは追記する tr で、直す必要がなければ null。
 */
export function stepPastHr(state: EditorState): Transaction | null {
  const { selection } = state;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== "hr") {
    return null;
  }
  const after = selection.to;
  const { tr } = state;
  tr.insert(after, state.schema.nodes.paragraph.create());
  tr.setSelection(TextSelection.create(tr.doc, after + 1));
  return tr;
}
