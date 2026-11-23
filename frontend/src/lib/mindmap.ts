/**
 * Turn the heading and list structure of the body into a mindmap tree.
 *
 * markmap-lib is not used, for two reasons:
 * - The converter (markmap-html-parser) throws the lists away when headings and lists sit
 *   side by side under the same parent. A note normally mixes `-` and subheadings under an
 *   H1, and branches disappearing silently is not acceptable
 * - It drags in the whole of cheerio for a conversion that goes through HTML. Built
 *   straight from the token stream, the markdown-it already here is enough
 *
 * This tree is handed to the renderer (markmap-view) as it is.
 */

import MarkdownIt from "markdown-it";
import type { Token } from "markdown-it";

export interface MindmapNode {
  content: string;
  children: MindmapNode[];
}

// html: false (the default) is kept. A note can also come down from the sync target, so
// raw HTML is escaped and shown as text
const md = new MarkdownIt();

function renderInline(token: Token): string {
  return md.renderer.renderInline(token.children ?? [], md.options, {});
}

function headingLevel(tag: string): number {
  return Number(tag.slice(1));
}

/**
 * Pick up only the headings (H1 to H6) and list items and build the tree. Plain paragraphs
 * and code blocks are content, not structure, so they do not go on the map.
 */
export function outlineToTree(markdown: string): MindmapNode {
  const root: MindmapNode = { content: "", children: [] };
  // The heading hierarchy. The first entry is always the root (level 0), so it never empties
  const headings: { node: MindmapNode; level: number }[] = [{ node: root, level: 0 }];
  const currentHeading = (): MindmapNode => headings.at(-1)?.node ?? root;
  // The parent of a nested list. Pushed on bullet_list_open, popped on close
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
        i += 2; // skip the inline and the heading_close
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
        // Only a list item's first line is its name. From the second paragraph on it is content
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

  // If there is exactly one top-level node, promote it to the root. An empty root placed in
  // the middle leaves just a nameless circle floating at the centre
  if (root.children.length === 1) {
    return root.children[0];
  }
  return root;
}
