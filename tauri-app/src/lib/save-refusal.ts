/**
 * 断られた保存の言い分。「どの理由で断られたか」「打った字が残ったか」
 * 「断られたノートの打鍵がいま画面に出ているか」の 3 つだけで決まる純関数。
 *
 * 画面から切り離してあるのは、この判断が保存の失敗経路すべての出口で、
 * 組み合わせの数がいちばん多いところだから。ノートを開いて打って断らせる
 * ところまで組まずに、表として確かめられるようにしておく。
 */

import { isBrokenNoteSave, isMissingNoteSave, isNotTextNoteSave, isStaleSave } from "./commands";
import { t } from "./i18n";

/**
 * 読み直しでは直らない拒否か。壊れた記録・消えたノート・文字として読めない
 * ファイルの 3 つ。どれも次の打鍵に望みが無いので、打った字はその場で退避する。
 * 判断を 1 か所に置くのは、印が増えたときに退避の経路から漏れると、打った字が
 * ディスクにも控えにも残らないまま黙って消えるから。
 */
export const refusedForGood = (error: unknown): boolean =>
  isBrokenNoteSave(error) || isMissingNoteSave(error) || isNotTextNoteSave(error);

/**
 * 断られた保存のあと、画面に何が出ているか。言い分はこれで決まる。
 *
 * - `draft`: 断られたノートが選ばれていて、本文は打ったぶんのまま。
 *   「画面にあるうちに写して」が届く唯一の場合
 * - `reloaded`: そのノートは選ばれているが、本文は読み直しで入れ替わった
 *   (譲ったぶんでも、A → B → A と戻って着いたぶんでも同じ)。打った字は
 *   もう画面に無いので、控えから取り出す話しかできない
 * - `away`: 画面にあるのは別のノート。画面の本文を指す案内は届かない
 */
export type RefusedScreen = "draft" | "reloaded" | "away";

/**
 * 断られた保存の言い分。`screen` は「断られたノートの打鍵がいま画面に出ているか」。
 * 出ていないなら画面の本文を指す案内は届かない — 画面にあるのは別のノートで、
 * 写す相手がそこに無い。名乗ってから、控えの在り処と取り出せるかだけを言う。
 * 消えたノートと、文字として読めないノートの控えは、控えとしては残るが、いま
 * 取り出す道が無い。開き直しても `read_note` が断られるので本文は載らず、
 * 「戻す」もそこで引き返す。
 * Stale だけはノートが書ける状態で残るので、開き直せば「戻す」で取り出せる —
 * ただし読み直しは選んでいるノートにしか走らないので、画面に無いぶんは
 * 「開き直してから」を先に言う。読み直しそのものが失敗した(`draft`)ときは、
 * 打った本文がまだ画面に残っているので、それを指して写してもらう。
 * AIDEV-NOTE: 孤児の控え(消えた・読めないノートのぶん)を開く一覧が無いので、取り出せないことを文言で正直に言うに留める(道は別 PR)
 */
export function refusalToast(
  error: unknown,
  kept: boolean,
  title: string,
  screen: RefusedScreen,
): string {
  const words = t().notes;
  // 打鍵が画面に残っているときだけ、画面の本文を指す案内が届く
  const onScreen = screen === "draft";
  if (!kept) {
    if (onScreen) {
      return words.saveNotKept;
    }
    // 読み直しが載ったぶんは、画面の本文もディスクのぶんに入れ替わっている。
    // 控えも無いので、打った字はもうどこにも無い
    if (screen === "reloaded" && isStaleSave(error)) {
      return words.staleNotKept;
    }
    return words.saveNotKeptAway(title);
  }
  if (isStaleSave(error)) {
    if (screen === "reloaded") {
      return words.editedElsewhere;
    }
    return onScreen ? words.staleNotReloaded : words.editedElsewhereAway(title);
  }
  if (isMissingNoteSave(error)) {
    return onScreen ? words.missingNote : words.missingNoteAway(title);
  }
  // 文字として読めないファイルは、記録が壊れているのとは手当てが違う。
  // 直すのは frontmatter ではなくファイルそのもので、開き直しても
  // `read_note` が同じ理由で断られるので「戻す」で取り出す道も無い
  if (isNotTextNoteSave(error)) {
    return onScreen ? words.notTextNote : words.notTextNoteAway(title);
  }
  return onScreen ? words.brokenMeta : words.brokenMetaAway(title);
}
