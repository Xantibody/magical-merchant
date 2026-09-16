import { liftListItem, splitListItem, wrapInList } from "@milkdown/kit/prose/schema-list";
import type { Command, Transaction } from "@milkdown/kit/prose/state";
import type { Node, NodeType, ResolvedPos } from "@milkdown/kit/prose/model";

type ListName = "bullet_list" | "ordered_list";

/** カーソルを包んでいる list_item と、その深さ。リストの外なら undefined。 */
function itemAround($pos: ResolvedPos, itemType: NodeType): number | undefined {
  let { depth } = $pos;
  while (depth > 0 && $pos.node(depth).type !== itemType) {
    depth -= 1;
  }
  return depth > 0 ? depth : undefined;
}

/**
 * チェック済みのタスクで Enter を押したとき、新しい項目は未チェックで作る。
 *
 * ProseMirror の splitListItem は項目の属性をそのまま複製するので、済んだ
 * タスクの次に打つ項目まで済んだことになってしまう。Notion や GitHub の
 * 編集画面と同じく、文字を持って行く側が印を持ち、空で生まれる側は外す。
 * 空の項目での Enter はリストから抜ける(splitListItem がそうする)ので、
 * そのときは触るものがない。
 */
export const splitTaskItem: Command = (state, dispatch) => {
  const itemType = state.schema.nodes.list_item;
  const { $from } = state.selection;
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
          // 先頭で押したときは文字が新しい項目へ移り、空になった前の項目が「新しい」側
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
 * 項目の先頭で Backspace を押したら、Shift-Tab と同じく一段外へ出す。
 *
 * Milkdown の既定は joinBackward で、前の項目の 2 段落目として吸い込まれる。
 * 見た目は印のない行が前の項目にぶら下がる形で、Markdown も `- one\n\n  two`
 * という緩い項目になる。Notion のように印を外して段落にする方が、押した
 * 人の「この行を項目でなくしたい」に合う。
 */
export const liftItemAtStart: Command = (state, dispatch) => {
  const itemType = state.schema.nodes.list_item;
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0) {
    return false;
  }
  // 項目の最初の段落だけ。2 段落目の先頭は段落の結合に任せる
  if ($from.node(-1).type !== itemType || $from.index(-1) !== 0) {
    return false;
  }
  return liftListItem(itemType)(state, dispatch);
};

/**
 * 選択範囲にかかる list_item を、始点側から順に。「かかる」のは項目の最初の
 * 段落で見る — nodesBetween は入れ子の外側の項目も返すが、内側の項目に
 * カーソルがあるだけで親の印まで切り替えるのは押した人の意図ではない。
 */
function itemsIn(
  doc: Node,
  itemType: NodeType,
  from: number,
  to: number,
): { node: Node; pos: number }[] {
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
 * Slack や Notion の書式バーと同じトグル。リストの外なら包み、同じ種類の
 * 中なら一段外へ出し、別の種類の中ならリストごと種類を変える。
 *
 * 種類を変えるときは項目の listType も揃える — syncListOrderPlugin は
 * 「先頭の項目が ordered の bullet_list」を番号付きに戻すので、リストだけ
 * 変えても元に戻される。
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
 * タスクの印を付け外しする。gfm は `- [ ]` を list_item の checked に畳む
 * だけなので、印の有無は checked が boolean か null かで決まる。リストの
 * 外なら箇条書きに包んでから印を付ける。
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
          // 段落ごとに項目ができる。選んだ段落の分だけ印を付ける
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
  // 先頭の項目に合わせて全部を同じ側へ倒す
  const checked = typeof items[0].node.attrs.checked === "boolean" ? null : false;
  const { tr } = state;
  for (const { node, pos } of items) {
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked });
  }
  dispatch(tr.scrollIntoView());
  return true;
};
