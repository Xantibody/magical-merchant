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
 * 選択にかかるコードブロックの行の、行頭の位置(文書座標)。選択が 1 つの
 * コードブロックに収まっていなければ undefined。行末ちょうどで終わる選択は
 * 次の行を含めない。
 */
function codeLineStarts(state: EditorState): number[] | undefined {
  const { $from, $to } = state.selection;
  if ($from.parent.type.name !== "code_block" || !$from.sameParent($to)) {
    return undefined;
  }
  const text = $from.parent.textContent;
  const base = $from.start();
  const starts = [text.lastIndexOf("\n", $from.parentOffset - 1) + 1];
  for (
    let i = text.indexOf("\n", starts[0]);
    i !== -1 && i + 1 < $to.parentOffset;
    i = text.indexOf("\n", i + 1)
  ) {
    starts.push(i + 1);
  }
  return starts.map((offset) => base + offset);
}

/**
 * コードブロックの中の Tab は字下げ。ProseMirror は Tab を扱わないので、
 * 素通しにするとブラウザがフォーカスを次の要素へ移し、書きかけの手が
 * エディタの外に落ちる。2 スペースなのは、Markdown のコードブロックで
 * 一番ありふれた幅だから(タブ文字は表示幅が環境で変わる)。
 *
 * 範囲を選んでいれば、その行すべての行頭に入れる。カーソルだけなら
 * その場に入れる(行の途中の Tab は行頭ではなくそこを空けたい)。
 */
export const indentCodeLine: Command = (state, dispatch) => {
  const starts = codeLineStarts(state);
  if (!starts) {
    return false;
  }
  if (!dispatch) {
    return true;
  }
  const { tr } = state;
  if (state.selection.empty) {
    tr.insertText(CODE_INDENT);
  } else {
    // 後ろの行から入れれば、前の行の位置がずれない
    for (const start of starts.toReversed()) {
      tr.insertText(CODE_INDENT, start, start);
    }
  }
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * コードブロックの中の Shift-Tab は行頭の字下げを一段戻す。範囲を選んで
 * いればその行すべて。戻すものがなくても受けたことにするのは、フォーカスを
 * 外へ逃がさないため。
 */
export const outdentCodeLine: Command = (state, dispatch) => {
  const starts = codeLineStarts(state);
  if (!starts) {
    return false;
  }
  if (!dispatch) {
    return true;
  }
  const text = state.selection.$from.parent.textContent;
  const base = state.selection.$from.start();
  const { tr } = state;
  for (const start of starts.toReversed()) {
    const indent = /^(?: {1,2}|\t)/u.exec(text.slice(start - base))?.[0];
    if (indent) {
      tr.delete(start, start + indent.length);
    }
  }
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * 入力ルールが `---` を水平線に置き換えたあと、カーソルを罫線の下の新しい
 * 段落へ置く。Milkdown の insertHrInputRule は置き換えるだけで選択を決めず、
 * 罫線そのものが選ばれた(NodeSelection の)状態で終わる。そこで次の文字を
 * 打つと罫線が消える。返すのは追記する tr で、直す必要がなければ null。
 *
 * 直後が空の段落ならそこへ置くだけ。文書の末尾では trailing プラグインが
 * 先に空段落を足しているので、こちらも足すと空行が 2 つ並ぶ。
 */
export function stepPastHr(state: EditorState): Transaction | null {
  const { selection } = state;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== "hr") {
    return null;
  }
  const after = selection.to;
  const { tr } = state;
  const next = state.doc.resolve(after).nodeAfter;
  if (!(next?.type.name === "paragraph" && next.content.size === 0)) {
    tr.insert(after, state.schema.nodes.paragraph.create());
  }
  tr.setSelection(TextSelection.create(tr.doc, after + 1));
  return tr;
}
