import { $prose } from "@milkdown/kit/utils";
import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { splitGlyphs } from "./glyphs";

interface GlyphRange {
  from: number;
  to: number;
  name: string;
  shortcode: string;
}

/** Inside a code span. Where the preview leaves text as text, so does this. */
function isInlineCode(node: ProseNode): boolean {
  return node.marks.some((mark) => mark.type.name === "inlineCode");
}

/** Collects the positions of registered `:name:` in the document. */
function glyphRanges(doc: ProseNode, glyphs: ReadonlyMap<string, string>): GlyphRange[] {
  const ranges: GlyphRange[] = [];
  doc.descendants((node, pos) => {
    if (node.type.spec.code) {
      return false;
    }
    if (!node.isText || !node.text?.includes(":") || isInlineCode(node)) {
      return;
    }
    let offset = 0;
    for (const segment of splitGlyphs(node.text, glyphs)) {
      if (segment.name !== null) {
        ranges.push({
          from: pos + offset,
          to: pos + offset + segment.text.length,
          name: segment.name,
          shortcode: segment.text,
        });
      }
      offset += segment.text.length;
    }
  });
  return ranges;
}

/**
 * Milkdown plugin that shows `:name:` as the registered image.
 *
 * In the same manner as note links, no node is added to the schema. The saved
 * form stays plain text in the body, and a decoration swaps in the image for
 * display only. While the cursor touches the range the saved form is shown as is.
 * With no image node, the write-back to Markdown is untouched too.
 */
export function createGlyphPlugin(glyphs: () => ReadonlyMap<string, string>): MilkdownPlugin[] {
  const decorations = $prose(
    () =>
      new Plugin({
        props: {
          decorations(state) {
            const registry = glyphs();
            // Fast path: do not scan a document with no registry or no `:` on every keystroke
            if (registry.size === 0 || !state.doc.textContent.includes(":")) {
              return DecorationSet.empty;
            }
            const { from, to } = state.selection;
            const decos: Decoration[] = [];
            for (const range of glyphRanges(state.doc, registry)) {
              // Touching an edge is enough to revert to the saved form. Typing next to it does not suddenly transform
              if (from <= range.to && to >= range.from) {
                decos.push(Decoration.inline(range.from, range.to, { class: "glyph-source" }));
              } else {
                decos.push(
                  Decoration.inline(range.from, range.to, { class: "glyph-hidden" }),
                  Decoration.widget(
                    range.from,
                    (view, getPos) => {
                      const img = document.createElement("img");
                      img.className = "glyph";
                      img.src = registry.get(range.name) ?? "";
                      img.alt = range.shortcode;
                      img.draggable = false;
                      // A press puts the cursor inside; the saved form appears and can be edited
                      img.addEventListener("mousedown", (e) => {
                        e.preventDefault();
                        const pos = getPos();
                        if (pos === undefined) {
                          return;
                        }
                        view.dispatch(
                          view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1)),
                        );
                        view.focus();
                      });
                      return img;
                    },
                    // An image of the same name is not redrawn. Without a key the
                    // <img> is rebuilt on every keystroke and flickers while the data URL reloads
                    { side: 1, key: `glyph:${range.name}` },
                  ),
                );
              }
            }
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
  );

  return [decorations];
}
