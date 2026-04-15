import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { DecorationSet, Decoration } from "@milkdown/kit/prose/view";

const placeholderPluginKey = new PluginKey("placeholder");

export function createPlaceholderPlugin(text: string) {
  return $prose(() => {
    return new Plugin({
      key: placeholderPluginKey,
      props: {
        decorations(state) {
          const { doc } = state;
          if (
            doc.childCount === 1 &&
            doc.firstChild?.isTextblock &&
            doc.firstChild.content.size === 0
          ) {
            const placeholder = Decoration.node(0, doc.firstChild.nodeSize, {
              class: "empty-node",
              "data-placeholder": text,
            });
            return DecorationSet.create(doc, [placeholder]);
          }
          return DecorationSet.empty;
        },
      },
    });
  });
}
