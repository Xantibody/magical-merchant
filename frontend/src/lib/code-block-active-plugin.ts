import { $prose } from "@milkdown/kit/utils";
import { Plugin } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { activeCodeBlockRanges } from "./active-code-block";

/**
 * Add the is-active class to the code_block the selection touches. ProseMirror reflects
 * the attributes of a node decoration onto the nodeView's dom, so the nodeView side needs
 * no wiring for the selection. The mermaid block's "the diagram is the main thing, the
 * source only while the caret is inside it" display (CSS) reads this class.
 */
export const codeBlockActivePlugin = $prose(
  () =>
    new Plugin({
      props: {
        decorations(state) {
          const { from, to } = state.selection;
          const ranges = activeCodeBlockRanges(state.doc, from, to);
          if (ranges.length === 0) {
            return DecorationSet.empty;
          }
          return DecorationSet.create(
            state.doc,
            ranges.map((range) => Decoration.node(range.from, range.to, { class: "is-active" })),
          );
        },
      },
    }),
);
