import { $prose } from "@milkdown/kit/utils";
import { Plugin } from "@milkdown/kit/prose/state";
import { stepPastHr } from "./block-commands";

/** The mark Milkdown's input rules leave on a tr. The plugin's key name plus "$". */
const INPUT_RULE_META = "MILKDOWN_CUSTOM_INPUTRULES$";

/**
 * Puts the cursor below the rule after the `---` input rule runs.
 *
 * AIDEV-NOTE: getting ahead of it in handleTextInput was rejected. Android's IME enters characters
 * through composition, so that path only ever goes through Milkdown's rule, which runs after
 * compositionend. Fixing it afterwards from the meta the rule leaves works for both paths.
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
