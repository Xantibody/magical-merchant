import { $prose } from "@milkdown/kit/utils";
import { keymap } from "@milkdown/kit/prose/keymap";
import { chainCommands } from "@milkdown/kit/prose/commands";
import { undoInputRule } from "@milkdown/kit/prose/inputrules";
import { liftItemAtStart, splitTaskItem } from "./list-commands";

/**
 * リスト項目の Enter と Backspace を Milkdown の既定より先に受ける。
 *
 * Milkdown は `$prose` のプラグインを全部並べた後ろに keymap を置くので、
 * ここに書いたキーが先に試され、断れば(false)いつもの動きに落ちる。
 * Backspace が undoInputRule から始まるのは、`- ` と打った直後の
 * Backspace が「箇条書きをやめて `- ` に戻す」であるべきだから — 既定の
 * 鎖でも先頭にあるものを、前に出た分だけ引き継ぐ。
 */
export const listKeymapPlugin = $prose(() =>
  keymap({
    Enter: splitTaskItem,
    Backspace: chainCommands(undoInputRule, liftItemAtStart),
  }),
);
