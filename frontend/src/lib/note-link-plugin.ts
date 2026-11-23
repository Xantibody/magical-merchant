import { $prose } from "@milkdown/kit/utils";
import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import type { Command } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { isImeComposing } from "./ime";
import { splitNoteLinks } from "./note-link";

/** The link target candidates. Workspace builds them from the current list and passes them. */
export interface NoteLinkTarget {
  id: string;
  title: string;
}

interface LinkRange {
  from: number;
  to: number;
  id: string;
  /** The display text written after `|`. The chip prefers this over the title. */
  alias: string | null;
}

/** Collect the positions of `[[ID]]` in the document. */
function linkRanges(doc: ProseNode): LinkRange[] {
  const ranges: LinkRange[] = [];
  doc.descendants((node, pos) => {
    if (node.type.spec.code) {
      return false;
    }
    if (
      !node.isText ||
      !node.text?.includes("[[") ||
      node.marks.some((mark) => mark.type.spec.code)
    ) {
      return;
    }
    let offset = 0;
    for (const segment of splitNoteLinks(node.text)) {
      if (segment.id !== null) {
        ranges.push({
          from: pos + offset,
          to: pos + offset + segment.text.length,
          id: segment.id,
          alias: segment.alias,
        });
      }
      offset += segment.text.length;
    }
  });
  return ranges;
}

function titleOf(targets: NoteLinkTarget[], id: string): string | undefined {
  return targets.find((target) => target.id === id)?.title;
}

/**
 * Type `[[`. The closing brackets are not inserted: NoteLinkSuggest below takes the rest,
 * and it is completed to `[[ID]]` the moment an ID is chosen. On a phone keyboard the
 * brackets sit deep in the symbol plane and take two steps, so an entry from the format
 * bar is provided.
 */
export const startNoteLink: Command = (state, dispatch) => {
  dispatch?.(state.tr.insertText("[[").scrollIntoView());
  return true;
};

/** The completion popup while `[[` is being typed. At any other time it shows nothing. */
class NoteLinkSuggest {
  private readonly root: HTMLDivElement;
  private readonly view: EditorView;
  private readonly targets: () => NoteLinkTarget[];
  private items: NoteLinkTarget[] = [];
  private cursor = 0;
  private matchFrom = -1;

  constructor(view: EditorView, targets: () => NoteLinkTarget[]) {
    this.view = view;
    this.targets = targets;
    this.root = document.createElement("div");
    this.root.className = "note-link-suggest";
    this.root.style.display = "none";
    document.body.append(this.root);
  }

  update(view: EditorView): void {
    const { state } = view;
    const { $from, empty } = state.selection;
    if (
      !empty ||
      !$from.parent.isTextblock ||
      $from.parent.type.spec.code ||
      (state.storedMarks ?? $from.marks()).some((mark) => mark.type.spec.code)
    ) {
      this.hide();
      return;
    }
    const before = $from.parent.textBetween(0, $from.parentOffset, "\n", "\n");
    const match = /\[\[(?<query>[^\n[\]]*)$/u.exec(before);
    if (!match) {
      this.hide();
      return;
    }
    const query = match.groups?.query ?? "";
    this.matchFrom = $from.pos - query.length;
    this.items = this.targets()
      .filter((t) => t.title.includes(query) || t.id.startsWith(query))
      .slice(0, 6);
    if (this.items.length === 0) {
      this.hide();
      return;
    }
    this.cursor = Math.min(this.cursor, this.items.length - 1);
    this.render(view);
  }

  /** Intercept the arrows and Enter only while the popup is shown. */
  handleKey(event: KeyboardEvent): boolean {
    if (this.root.style.display === "none") {
      return false;
    }
    if (event.key === "ArrowDown") {
      this.cursor = (this.cursor + 1) % this.items.length;
      this.render(this.view);
      return true;
    }
    if (event.key === "ArrowUp") {
      this.cursor = (this.cursor - 1 + this.items.length) % this.items.length;
      this.render(this.view);
      return true;
    }
    // The Enter that confirms a conversion belongs to the IME. It does not pick a candidate (#102)
    if (event.key === "Enter" && !isImeComposing(event)) {
      this.pick(this.items[this.cursor]);
      return true;
    }
    if (event.key === "Escape") {
      this.hide();
      return true;
    }
    return false;
  }

  private pick(target: NoteLinkTarget | undefined): void {
    if (!target) {
      return;
    }
    const { state } = this.view;
    // Complete the half-typed `[[query` into `[[ID]]`
    this.view.dispatch(state.tr.insertText(`${target.id}]]`, this.matchFrom, state.selection.from));
    this.view.focus();
    this.hide();
  }

  private render(view: EditorView): void {
    this.root.replaceChildren(
      ...this.items.map((target, index) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "note-link-suggest-item";
        row.classList.toggle("note-link-suggest-item--active", index === this.cursor);
        row.textContent = target.title;
        // Keep the editor from losing focus on the mousedown that comes before click
        row.addEventListener("mousedown", (e) => {
          e.preventDefault();
          this.pick(target);
        });
        return row;
      }),
    );
    const coords = view.coordsAtPos(view.state.selection.from);
    this.root.style.display = "block";
    this.root.style.top = `${coords.bottom + 4}px`;
    this.root.style.left = `${coords.left}px`;
  }

  private hide(): void {
    this.root.style.display = "none";
  }

  destroy(): void {
    this.root.remove();
  }
}

/**
 * The bundle of Milkdown plugins that shows a `[[ID]]` link as a chip of its title.
 *
 * No node is added to the schema: the stored form stays plain text in the body, and a
 * decoration swaps only the display for the title. While the cursor touches the range,
 * the stored form is shown as it is (the same manner as a code block's is-active).
 */
export function createNoteLinkPlugin(targets: () => NoteLinkTarget[]): MilkdownPlugin[] {
  const decorations = $prose(
    () =>
      new Plugin({
        props: {
          decorations(state) {
            // Fast path: do not scan a document with no links on every keystroke
            if (!state.doc.textContent.includes("[[")) {
              return DecorationSet.empty;
            }
            const { from, to } = state.selection;
            const decos: Decoration[] = [];
            for (const range of linkRanges(state.doc)) {
              // Even touching an edge returns the stored form: typing beside it, it does
              // not suddenly change shape
              if (from <= range.to && to >= range.from) {
                decos.push(Decoration.inline(range.from, range.to, { class: "note-link-source" }));
              } else {
                decos.push(
                  Decoration.inline(range.from, range.to, { class: "note-link-hidden" }),
                  Decoration.widget(
                    range.from,
                    (view) => {
                      const chip = document.createElement("span");
                      chip.className = "note-link-chip";
                      chip.textContent =
                        range.alias ?? titleOf(targets(), range.id) ?? `[[${range.id}]]`;
                      // Pressing it puts the cursor inside; the stored form appears and can be edited
                      chip.addEventListener("mousedown", (e) => {
                        e.preventDefault();
                        view.dispatch(
                          view.state.tr.setSelection(
                            TextSelection.create(view.state.doc, range.from + 2),
                          ),
                        );
                        view.focus();
                      });
                      return chip;
                    },
                    { side: 1 },
                  ),
                );
              }
            }
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
  );

  let suggest: NoteLinkSuggest | undefined;
  const autocomplete = $prose(
    () =>
      new Plugin({
        view(editorView) {
          suggest = new NoteLinkSuggest(editorView, targets);
          return {
            update: (view) => suggest?.update(view),
            destroy: () => {
              suggest?.destroy();
              suggest = undefined;
            },
          };
        },
        props: {
          handleKeyDown: (_view, event) => suggest?.handleKey(event) ?? false,
        },
      }),
  );

  return [decorations, autocomplete];
}
