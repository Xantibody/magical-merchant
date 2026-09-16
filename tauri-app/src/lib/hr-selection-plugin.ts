import { $prose } from "@milkdown/kit/utils";
import { Plugin } from "@milkdown/kit/prose/state";
import { stepPastHr } from "./block-commands";

/** Milkdown の入力ルールが tr に残す印。プラグインの key 名 + "$"。 */
const INPUT_RULE_META = "MILKDOWN_CUSTOM_INPUTRULES$";

/**
 * `---` の入力ルールのあとにカーソルを罫線の下へ置く。
 *
 * AIDEV-NOTE: handleTextInput で先回りする案は捨てた。Android の IME は文字を
 * composition で入れるので、そちらは compositionend 後に走る Milkdown の
 * ルールしか通らない。ルールが残す meta を見て後から直せば、両方の道に効く。
 */
export const hrSelectionPlugin = $prose(
  () =>
    new Plugin({
      appendTransaction: (transactions, _old, state) => {
        if (!transactions.some((tr) => tr.getMeta(INPUT_RULE_META))) {
          return null;
        }
        return stepPastHr(state);
      },
    }),
);
