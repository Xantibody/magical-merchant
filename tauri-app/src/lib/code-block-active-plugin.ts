import { $prose } from "@milkdown/kit/utils";
import { Plugin } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { activeCodeBlockRanges } from "./active-code-block";

/**
 * 選択が触れている code_block に is-active クラスを付ける。node decoration の
 * 属性は ProseMirror が nodeView の dom に反映するので、nodeView 側に選択の
 * 配線は要らない。mermaid ブロックの「図がメイン、ソースはカーソルが中に
 * ある間だけ」表示(CSS)がこのクラスを読む。
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
