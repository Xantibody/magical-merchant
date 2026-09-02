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

/** コードスパンの中身。プレビューが文字のまま出すところは、ここでも同じ。 */
function isInlineCode(node: ProseNode): boolean {
  return node.marks.some((mark) => mark.type.name === "inlineCode");
}

/** 文書中の、登録済みの `:name:` の位置を集める。 */
function glyphRanges(doc: ProseNode, glyphs: ReadonlyMap<string, string>): GlyphRange[] {
  const ranges: GlyphRange[] = [];
  doc.descendants((node, pos) => {
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
 * `:name:` を登録済みの画像として見せる Milkdown プラグイン。
 *
 * ノート間リンクと同じ流儀で、スキーマにノードは足さない — 保存形は
 * 本文中のプレーンテキストのままで、装飾(decoration)が表示だけを画像に
 * 差し替える。カーソルが範囲に触れている間は保存形をそのまま見せる。
 * 画像ノードを持たないので、Markdown への書き戻しにも手が入らない。
 */
export function createGlyphPlugin(glyphs: () => ReadonlyMap<string, string>): MilkdownPlugin[] {
  const decorations = $prose(
    () =>
      new Plugin({
        props: {
          decorations(state) {
            const registry = glyphs();
            // 速い経路: 登録が無い・`:` の無い文書を毎打鍵ごとに走査しない
            if (registry.size === 0 || !state.doc.textContent.includes(":")) {
              return DecorationSet.empty;
            }
            const { from, to } = state.selection;
            const decos: Decoration[] = [];
            for (const range of glyphRanges(state.doc, registry)) {
              // 端に触れただけでも保存形に戻す。隣で打っていて急に化けない
              if (from <= range.to && to >= range.from) {
                decos.push(Decoration.inline(range.from, range.to, { class: "glyph-source" }));
              } else {
                decos.push(
                  Decoration.inline(range.from, range.to, { class: "glyph-hidden" }),
                  Decoration.widget(
                    range.from,
                    (view) => {
                      const img = document.createElement("img");
                      img.className = "glyph";
                      img.src = registry.get(range.name) ?? "";
                      img.alt = range.shortcode;
                      img.draggable = false;
                      // 押すとカーソルが中に入り、保存形が現れて編集できる
                      img.addEventListener("mousedown", (e) => {
                        e.preventDefault();
                        view.dispatch(
                          view.state.tr.setSelection(
                            TextSelection.create(view.state.doc, range.from + 1),
                          ),
                        );
                        view.focus();
                      });
                      return img;
                    },
                    // 同じ名前の画像は描き直さない。key が無いと打鍵のたびに
                    // <img> が作り直され、データ URL の読み直しでちらつく
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
