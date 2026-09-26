import { $prose } from "@milkdown/kit/utils";
import { Plugin } from "@milkdown/kit/prose/state";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import { Transform } from "@milkdown/kit/prose/transform";

/** What prosemirror-inputrules keeps so that undoInputRule can take a rule back */
interface Undoable {
  transform: Transform;
  from: number;
  to: number;
  text: string;
}

function carriedOver(
  rules: Plugin,
  transactions: readonly Transaction[],
  oldState: EditorState,
  newState: EditorState,
): Undoable | undefined {
  if (rules.getState(newState)) {
    return undefined;
  }
  // A plugin placed after the appender sees the rule's own transaction first; one
  // placed before it sees only the appended ones, with the rule already in oldState
  const [first, ...rest] = transactions;
  const own = first?.getMeta(rules) as Undoable | undefined;
  const before = own ?? (rules.getState(oldState) as Undoable | null);
  const appended = own ? rest : transactions;
  // Only what the rule's own dispatch appended; anything the user does next resets it
  if (
    !before ||
    appended.length === 0 ||
    !appended.every((tr) => tr.getMeta("appendedTransaction") === before.transform)
  ) {
    return undefined;
  }
  const transform = new Transform(before.transform.before);
  for (const tr of [before.transform, ...appended]) {
    for (const step of tr.steps) {
      transform.step(step);
    }
  }
  return { ...before, transform };
}

/**
 * Keeps an input rule undoable through the transactions appended after it.
 *
 * When `- ` or `1. ` wraps the last block in a list, the trailing plugin appends an
 * empty paragraph in a follow-up transaction. The inputrules state resets on any
 * doc change, so that append alone used to make the next Backspace lift the item
 * instead of giving `- ` back (#246). Here the appended steps are folded into the
 * rule's own transform, so undoInputRule takes back everything that one keystroke
 * caused, the trailing paragraph included, and the doc ends up as it was typed.
 *
 * AIDEV-NOTE: The other way was to hold the trailing append back right after an
 * input rule. Rejected: it means replacing Milkdown's trailing plugin, and a list
 * made at the end would sit without its empty paragraph below until the next edit,
 * breaking the guarantee that the doc always ends in one (#246).
 */
export const inputRuleUndoPlugin = $prose(
  () =>
    new Plugin({
      appendTransaction(transactions, oldState, newState) {
        for (const rules of newState.plugins.filter((plugin) => plugin.spec.isInputRules)) {
          const kept = carriedOver(rules, transactions, oldState, newState);
          if (kept) {
            return newState.tr.setMeta(rules, kept);
          }
        }
        return null;
      },
    }),
);
