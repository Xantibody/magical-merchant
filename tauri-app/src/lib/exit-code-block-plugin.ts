import { $prose } from "@milkdown/kit/utils";
import { TextSelection } from "@milkdown/kit/prose/state";
import { keymap } from "@milkdown/kit/prose/keymap";

/**
 * Exit a code block by pressing Mod+Enter (Cmd+Enter on Mac).
 * Inserts a new paragraph after the code block and moves the cursor there.
 */
export const exitCodeBlockPlugin = $prose(() => {
  return keymap({
    "Mod-Enter": (state, dispatch) => {
      const { $from } = state.selection;
      const node = $from.node($from.depth);
      if (node.type.name !== "code_block") return false;

      if (!dispatch) return true;
      const endOfBlock = $from.after($from.depth);
      const tr = state.tr;
      const paragraphType = state.schema.nodes.paragraph;
      tr.insert(endOfBlock, paragraphType.create());
      tr.setSelection(
        TextSelection.near(tr.doc.resolve(endOfBlock + 1)),
      );
      dispatch(tr);
      return true;
    },
  });
});
