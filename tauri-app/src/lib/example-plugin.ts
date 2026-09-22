import { $prose } from "@milkdown/kit/utils";
import { Plugin } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";

/**
 * A Milkdown plugin that puts a template's example text in faint type at the end of the
 * section under its heading.
 *
 * Not one character goes into the document: it is a widget decoration, so it appears
 * neither in the Markdown written back, nor in the save, nor in search. It is the extreme
 * end of the same style as note links and glyphs (`glyph-plugin.ts`), where the saved form
 * stays as it is and only the appearance changes.
 *
 * It is not removed once writing starts. In a template with two questions under one
 * heading, if the first character removed the example with it, the example would be lost at
 * the exact moment of answering the second question. When it gets in the way, the whole set
 * can be hidden from the `...` menu.
 */
function render(lines: string[]): HTMLElement {
  const box = document.createElement("div");
  box.className = "note-example";
  box.contentEditable = "false";
  for (const line of lines) {
    const row = document.createElement("div");
    row.className = "note-example-line";
    row.textContent = line;
    box.append(row);
  }
  return box;
}

export function createExamplePlugin(
  examples: () => ReadonlyMap<string, string[]>,
): MilkdownPlugin[] {
  const decorations = $prose(
    () =>
      new Plugin({
        props: {
          decorations(state) {
            const table = examples();
            if (table.size === 0) {
              return DecorationSet.empty;
            }

            const decos: Decoration[] = [];
            let heading = "";
            const place = (at: number): void => {
              const lines = table.get(heading);
              if (lines) {
                decos.push(
                  // The key that prevents a redraw. Without it the DOM is rebuilt on every
                  // keystroke and the same text flickers for an instant
                  Decoration.widget(at, () => render(lines), { side: -1, key: `eg:${heading}` }),
                );
              }
            };

            // Split at the headings and place it at the end of that section (just before
            // the next heading). It hangs under what was written, so the example never
            // pushes a written line aside
            state.doc.forEach((node, offset) => {
              if (node.type.name === "heading") {
                place(offset);
                heading = node.textContent.trim();
              }
            });
            place(state.doc.content.size);

            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
  );

  return [decorations];
}
