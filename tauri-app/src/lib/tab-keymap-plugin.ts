import { $shortcut } from "@milkdown/kit/utils";
import { indentCodeLine, outdentCodeLine } from "./block-commands";

/**
 * Tab / Shift-Tab がリストや表に受けられなかったときの受け皿。
 *
 * ProseMirror は Tab を扱わないので、リストの外(段落・コードブロック・
 * 沈められない先頭の項目)で押すとブラウザがフォーカスを次の要素へ移し、
 * 書きかけの手がエディタの外に落ちる。コードブロックでは字下げ、それ以外
 * では何もしないが受けたことにして、カーソルを動かさない。
 *
 * priority 0 で最後に並ぶ(既定は 50、高い順)。sinkListItem や表のセル移動
 * が先に試され、全部断ったときだけここに来る。
 */
export const tabKeymapPlugin = $shortcut(() => ({
  Tab: {
    key: "Tab",
    priority: 0,
    onRun: () => (state, dispatch) => indentCodeLine(state, dispatch) || true,
  },
  "Shift-Tab": {
    key: "Shift-Tab",
    priority: 0,
    onRun: () => (state, dispatch) => outdentCodeLine(state, dispatch) || true,
  },
}));
