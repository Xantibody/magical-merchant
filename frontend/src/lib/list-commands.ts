import { liftListItem, splitListItem, wrapInList } from "@milkdown/kit/prose/schema-list";
import type { Command, Transaction } from "@milkdown/kit/prose/state";
import type { Node, NodeType, ResolvedPos } from "@milkdown/kit/prose/model";

type ListName = "bullet_list" | "ordered_list";

/** The depth of the list_item wrapping the cursor. undefined outside a list. */
function itemAround($pos: ResolvedPos, itemType: NodeType): number | undefined {
  let { depth } = $pos;
  while (depth > 0 && $pos.node(depth).type !== itemType) {
    depth -= 1;
  }
  return depth > 0 ? depth : undefined;
}

/**
 * When Enter is pressed on a checked task, create the new item unchecked.
 *
 * ProseMirror's splitListItem copies an item's attributes as they are, so the item typed
 * after a done task would count as done too. As in Notion's and GitHub's editors, the side
 * that carries the text keeps the mark and the side born empty has it removed. Enter on an
 * empty item leaves the list (splitListItem does that), so there is nothing to touch then.
 */
export const splitTaskItem: Command = (state, dispatch) => {
  const itemType = state.schema.nodes.list_item;
  const { $from } = state.selection;
  // Selecting a whole horizontal rule or the like gives depth 0, which has no parent
  if ($from.depth === 0) {
    return false;
  }
  const item = $from.node(-1);
  if (item.type !== itemType || item.attrs.checked !== true) {
    return false;
  }
  const textMoves = $from.parentOffset === 0;
  return splitListItem(itemType)(
    state,
    dispatch &&
      ((tr: Transaction) => {
        const $cursor = tr.selection.$from;
        const landed = $cursor.node(-1);
        if (landed.type === itemType) {
          // Pressed at the start, the text moves into the new item and the previous item,
          // now empty, is the "new" side
          const pos = textMoves
            ? $cursor.before(-1) - (tr.doc.resolve($cursor.before(-1)).nodeBefore?.nodeSize ?? 0)
            : $cursor.before(-1);
          const target = tr.doc.nodeAt(pos);
          if (target?.type === itemType && target.attrs.checked === true) {
            tr.setNodeMarkup(pos, undefined, { ...target.attrs, checked: false });
          }
        }
        dispatch(tr);
      }),
  );
};

/**
 * Backspace at the start of an item lifts it out one level, the same as Shift-Tab.
 *
 * Milkdown's default is joinBackward, which sucks it in as the second paragraph of the
 * previous item. It looks like an unmarked line hanging off the previous item, and the
 * Markdown becomes a loose item, `- one\n\n  two`. Removing the mark and making it a
 * paragraph, as Notion does, matches what the person pressing it wants: this line to
 * stop being an item.
 */
export const liftItemAtStart: Command = (state, dispatch) => {
  const itemType = state.schema.nodes.list_item;
  const { $from, empty } = state.selection;
  if (!empty || $from.depth === 0 || $from.parentOffset !== 0) {
    return false;
  }
  // Only an item's first paragraph. The start of a second one is left to the paragraph join
  if ($from.node(-1).type !== itemType || $from.index(-1) !== 0) {
    return false;
  }
  return liftListItem(itemType)(state, dispatch);
};

/**
 * The list_items the selection touches, in order from the start of the selection.
 *
 * With a bare cursor, the single innermost item (the same item even in the second paragraph
 * of a loose item). With a range, the ones whose first paragraph overlaps it: nodesBetween
 * also returns the outer items of a nesting, but flipping the parent's mark just because an
 * inner item was selected is not what the person pressing it meant.
 */
function itemsIn(
  doc: Node,
  itemType: NodeType,
  from: number,
  to: number,
): { node: Node; pos: number }[] {
  if (from === to) {
    const $cursor = doc.resolve(from);
    const depth = itemAround($cursor, itemType);
    return depth === undefined ? [] : [{ node: $cursor.node(depth), pos: $cursor.before(depth) }];
  }
  const found: { node: Node; pos: number }[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type !== itemType) {
      return;
    }
    const first = node.firstChild;
    const start = pos + 1;
    const end = first ? start + first.nodeSize : start;
    if (start <= to && end >= from) {
      found.push({ node, pos });
    }
  });
  return found;
}

/**
 * The same toggle as Slack's and Notion's formatting bars. Outside a list it wraps, inside
 * the same kind it lifts out one level, inside another kind it changes the whole list's
 * kind.
 *
 * When the kind changes, the items' listType is brought in line too: syncListOrderPlugin
 * turns a "bullet_list whose first item is ordered" back into a numbered list, so changing
 * only the list would be undone.
 */
function toggleList(name: ListName): Command {
  return (state, dispatch) => {
    const { nodes } = state.schema;
    const listType = nodes[name];
    const itemType = nodes.list_item;
    const { $from } = state.selection;
    const depth = itemAround($from, itemType);
    if (depth === undefined) {
      return wrapInList(listType)(state, dispatch);
    }
    const list = $from.node(depth - 1);
    if (list.type === listType) {
      return liftListItem(itemType)(state, dispatch);
    }
    if (!dispatch) {
      return true;
    }
    const listPos = $from.before(depth - 1);
    const listKind = name === "ordered_list" ? "ordered" : "bullet";
    const { tr } = state;
    tr.setNodeMarkup(listPos, listType, { spread: list.attrs.spread });
    list.forEach((child, offset) => {
      tr.setNodeMarkup(listPos + 1 + offset, undefined, {
        ...child.attrs,
        listType: listKind,
        label: listKind === "ordered" ? "1." : "•",
      });
    });
    dispatch(tr.scrollIntoView());
    return true;
  };
}

export const toggleBulletList: Command = toggleList("bullet_list");
export const toggleOrderedList: Command = toggleList("ordered_list");

/**
 * Add or remove the task mark. gfm only folds `- [ ]` into a list_item's checked, so
 * whether the mark is there is decided by checked being a boolean or null. Outside a list,
 * wrap in a bullet list first, then add the mark.
 */
export const toggleTaskItem: Command = (state, dispatch) => {
  const { nodes } = state.schema;
  const itemType = nodes.list_item;
  const { from, to } = state.selection;
  const items = itemsIn(state.doc, itemType, from, to);
  if (items.length === 0) {
    return wrapInList(nodes.bullet_list)(
      state,
      dispatch &&
        ((tr: Transaction) => {
          // One item is made per paragraph. Mark as many as the paragraphs selected
          const wrapped = itemsIn(tr.doc, itemType, tr.selection.from, tr.selection.to);
          for (const { node, pos } of wrapped) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: false });
          }
          dispatch(tr);
        }),
    );
  }
  if (!dispatch) {
    return true;
  }
  // Tip them all the same way, following the first item
  const checked = typeof items[0].node.attrs.checked === "boolean" ? null : false;
  const { tr } = state;
  for (const { node, pos } of items) {
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked });
  }
  dispatch(tr.scrollIntoView());
  return true;
};
