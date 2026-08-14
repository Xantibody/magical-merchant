/**
 * 本文の見出し・リスト構造をマインドマップの木にする。
 *
 * markmap-lib を使わないのは 2 つの理由から:
 * - 変換器(markmap-html-parser)は、見出しとリストが同じ親の下に並ぶと
 *   リストを捨てる。ノートは「H1 の下に `-` と小見出しが混在」が普通の形で、
 *   枝が黙って消えるのは受け入れられない
 * - HTML 経由の変換のために cheerio を丸ごと連れてくる。トークン列から
 *   直接組めば、既にある markdown-it だけで足りる
 *
 * 描画(markmap-view)にはこの木をそのまま渡す。
 */

import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

export interface MindmapNode {
  content: string;
  children: MindmapNode[];
}

// html: false(既定)のまま使う。ノートは同期先から降ってくることもあり、
// 生の HTML はエスケープして文字として見せる
const md = new MarkdownIt();

function renderInline(token: Token): string {
  return md.renderer.renderInline(token.children ?? [], md.options, {});
}

function headingLevel(tag: string): number {
  return Number(tag.slice(1));
}

/**
 * 見出し(H1〜H6)とリスト項目だけを拾って木を組む。地の文の段落や
 * コードブロックは構造ではなく中身なので、マップには出さない。
 */
export function outlineToTree(markdown: string): MindmapNode {
  const root: MindmapNode = { content: "", children: [] };
  // 見出しの階層。先頭は常にルート(レベル 0)なので空にはならない
  const headings: { node: MindmapNode; level: number }[] = [{ node: root, level: 0 }];
  const currentHeading = (): MindmapNode => headings.at(-1)?.node ?? root;
  // 入れ子リストの親。bullet_list_open で積み、close で下ろす
  const listParents: MindmapNode[] = [];
  let lastItem: MindmapNode | undefined;
  let itemDepth = 0;

  const tokens = md.parse(markdown, {});
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    switch (token.type) {
      case "heading_open": {
        const level = headingLevel(token.tag);
        while ((headings.at(-1)?.level ?? 0) >= level) {
          headings.pop();
        }
        const node: MindmapNode = { content: renderInline(tokens[i + 1]), children: [] };
        currentHeading().children.push(node);
        headings.push({ node, level });
        i += 2; // inline と heading_close を読み飛ばす
        break;
      }
      case "bullet_list_open":
      case "ordered_list_open": {
        listParents.push(itemDepth > 0 && lastItem ? lastItem : currentHeading());
        break;
      }
      case "bullet_list_close":
      case "ordered_list_close": {
        listParents.pop();
        break;
      }
      case "list_item_open": {
        const node: MindmapNode = { content: "", children: [] };
        (listParents.at(-1) ?? currentHeading()).children.push(node);
        lastItem = node;
        itemDepth += 1;
        break;
      }
      case "list_item_close": {
        itemDepth -= 1;
        break;
      }
      case "inline": {
        // リスト項目の最初の行だけが項目の名前。2 段落目以降は中身とみなす
        if (itemDepth > 0 && lastItem && lastItem.content === "") {
          lastItem.content = renderInline(token);
        }
        break;
      }
      default: {
        break;
      }
    }
  }

  // トップレベルが 1 つだけなら、それをルートに昇格させる。空のルートを
  // 真ん中に置くと、中心に名無しの丸だけが浮かぶ
  if (root.children.length === 1) {
    return root.children[0];
  }
  return root;
}
