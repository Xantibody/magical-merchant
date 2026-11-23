import { headingSchema, paragraphSchema } from "@milkdown/kit/preset/commonmark";
import { setBlockType } from "@milkdown/kit/prose/commands";
import { textblockTypeInputRule } from "@milkdown/kit/prose/inputrules";
import { keymap } from "@milkdown/kit/prose/keymap";
import type { NodeType } from "@milkdown/kit/prose/model";
import type { Command } from "@milkdown/kit/prose/state";
import { $inputRule, $prose } from "@milkdown/kit/utils";

/**
 * `#` to `######` and a space at the start of a block make a heading of that many levels.
 *
 * Replaces Milkdown's rule, which added the count to the level of a block that was already a
 * heading: `# ` at the start of an H2 made an H3, never an H1.
 */
export const headingInputRule = $inputRule((ctx) =>
  textblockTypeInputRule(/^(?<hashes>#{1,6})\s$/u, headingSchema.type(ctx), (match) => ({
    level: match.groups?.hashes?.length ?? 1,
  })),
);

/** With the caret before a heading's first letter, makes it a paragraph. Anywhere else it declines. */
function headingToParagraph(heading: NodeType, paragraph: NodeType): Command {
  return (state, dispatch) => {
    const { $from, empty } = state.selection;
    if (!empty || $from.parentOffset !== 0 || $from.parent.type !== heading) {
      return false;
    }
    return setBlockType(paragraph)(state, dispatch);
  };
}

/**
 * Backspace at the start of a heading turns it into a paragraph in one press.
 *
 * Milkdown's own Backspace there stepped the level down one at a time, so an H3 took four
 * presses to reach the line above. This sits after listKeymapPlugin, whose undoInputRule still
 * gives `## ` back when the Backspace comes right after the rule.
 */
export const headingKeymapPlugin = $prose((ctx) =>
  keymap({ Backspace: headingToParagraph(headingSchema.type(ctx), paragraphSchema.type(ctx)) }),
);
