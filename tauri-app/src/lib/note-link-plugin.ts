import { $prose } from "@milkdown/kit/utils";
import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { isImeComposing } from "./ime";
import { splitNoteLinks } from "./note-link";

/** リンク先の候補。Workspace が今の一覧から作って渡す。 */
export interface NoteLinkTarget {
  id: string;
  title: string;
}

interface LinkRange {
  from: number;
  to: number;
  id: string;
}

/** 文書中の `[[ID]]` の位置を集める。 */
function linkRanges(doc: ProseNode): LinkRange[] {
  const ranges: LinkRange[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text?.includes("[[")) {
      return;
    }
    let offset = 0;
    for (const segment of splitNoteLinks(node.text)) {
      if (segment.id !== null) {
        ranges.push({ from: pos + offset, to: pos + offset + segment.text.length, id: segment.id });
      }
      offset += segment.text.length;
    }
  });
  return ranges;
}

function titleOf(targets: NoteLinkTarget[], id: string): string | undefined {
  return targets.find((target) => target.id === id)?.title;
}

/** `[[` を打っている途中の補完候補ポップアップ。それ以外のときは何も出さない。 */
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
    if (!empty || !$from.parent.isTextblock) {
      this.hide();
      return;
    }
    const before = $from.parent.textBetween(0, $from.parentOffset, "\n", "\n");
    const match = /\[\[([^\n[\]]*)$/.exec(before);
    if (!match) {
      this.hide();
      return;
    }
    const [, query] = match;
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

  /** ポップアップが出ている間だけ矢印と Enter を横取りする。 */
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
    // 変換確定の Enter は IME のもの。候補の確定には使わない (#102)
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
    // 打ちかけの `[[query` を `[[ID]]` に完成させる
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
        // click より前の mousedown でエディタがフォーカスを失うのを防ぐ
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
 * `[[ID]]` のリンクをタイトルのチップとして見せる Milkdown プラグイン束。
 *
 * スキーマにノードは足さない — 保存形はあくまで本文中のプレーンテキストで、
 * 装飾(decoration)が表示だけをタイトルに差し替える。カーソルが範囲に
 * 触れている間は保存形をそのまま見せる(コードブロックの is-active と
 * 同じ流儀)。
 */
export function createNoteLinkPlugin(targets: () => NoteLinkTarget[]): MilkdownPlugin[] {
  const decorations = $prose(
    () =>
      new Plugin({
        props: {
          decorations(state) {
            // 速い経路: リンクの無い文書を毎打鍵ごとに走査しない
            if (!state.doc.textContent.includes("[[")) {
              return DecorationSet.empty;
            }
            const { from, to } = state.selection;
            const decos: Decoration[] = [];
            for (const range of linkRanges(state.doc)) {
              // 端に触れただけでも保存形に戻す。隣で打っていて急に化けない
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
                      chip.textContent = titleOf(targets(), range.id) ?? `[[${range.id}]]`;
                      // 押すとカーソルが中に入り、保存形が現れて編集できる
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
