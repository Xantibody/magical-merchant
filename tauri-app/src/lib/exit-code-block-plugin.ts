import { $prose } from "@milkdown/kit/utils";
import { keymap } from "@milkdown/kit/prose/keymap";
import { exitCodeBlock } from "./block-commands";

/**
 * Exit a code block by pressing Mod+Enter (Cmd+Enter on Mac).
 * The command itself lives in block-commands.ts so the touch toolbar,
 * which has no modifier keys to offer, can call the same thing.
 */
export const exitCodeBlockPlugin = $prose(() =>
  keymap({
    "Mod-Enter": exitCodeBlock,
  }),
);
