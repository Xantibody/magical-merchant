import { $prose } from "@milkdown/kit/utils";
import { keymap } from "@milkdown/kit/prose/keymap";
import { chainCommands } from "@milkdown/kit/prose/commands";
import { undoInputRule } from "@milkdown/kit/prose/inputrules";
import { liftItemAtStart, splitTaskItem } from "./list-commands";

/**
 * Receives Enter and Backspace in a list item ahead of Milkdown's defaults.
 *
 * Milkdown places its keymap after all the `$prose` plugins, so the keys written
 * here are tried first, and if they decline (false) the usual behaviour takes over.
 * Backspace starts with undoInputRule because a Backspace right after typing `- `
 * should mean "stop the bullet and go back to `- `": what sits at the head of the
 * default chain is carried over, just because we moved in front of it.
 */
export const listKeymapPlugin = $prose(() =>
  keymap({
    Enter: splitTaskItem,
    Backspace: chainCommands(undoInputRule, liftItemAtStart),
  }),
);
