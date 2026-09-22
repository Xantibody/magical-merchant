import { $prose } from "@milkdown/kit/utils";
import { Plugin } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";

/**
 * テンプレの記入例を、その見出しのセクションの末尾に薄字で置く Milkdown
 * プラグイン。
 *
 * 文書には 1 文字も入れない — widget decoration なので、書き戻す Markdown
 * にも、保存にも、検索にも現れない。ノートリンクやグリフ(`glyph-plugin.ts`)が
 * 「保存形はそのまま、見え方だけ変える」のと同じ流儀の、その極端な側。
 *
 * 書き始めても消さない。1 つの見出しに問いが 2 つ並ぶテンプレで、最初の
 * 1 文字で例ごと消えると、2 つ目の問いを答えようとしたその瞬間に失う。
 * 邪魔になったときは `…` から全部消せる。
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
                  // 描き直さないための key。無いと打鍵のたびに DOM が
                  // 作り直され、同じ文字が一瞬ちらつく
                  Decoration.widget(at, () => render(lines), { side: -1, key: `eg:${heading}` }),
                );
              }
            };

            // 見出しで区切って、そのセクションの終わり(次の見出しの直前)に置く。
            // 書いたものの下に付くので、例は書いた行を押しのけない
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
