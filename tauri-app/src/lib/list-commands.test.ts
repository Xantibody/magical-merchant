import { describe, it, expect } from "vitest";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
import type { Command } from "@milkdown/kit/prose/state";
import type { Node } from "@milkdown/kit/prose/model";
import {
  liftItemAtStart,
  splitTaskItem,
  toggleBulletList,
  toggleOrderedList,
  toggleTaskItem,
} from "./list-commands";

// commonmark / gfm の list まわりの形だけを再現した最小スキーマ。属性名と
// 既定値は Milkdown のもの(list_item の checked は gfm が足す)
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*" },
    hr: { group: "block" },
    bullet_list: { group: "block", content: "list_item+", attrs: { spread: { default: false } } },
    ordered_list: {
      group: "block",
      content: "list_item+",
      attrs: { order: { default: 1 }, spread: { default: false } },
    },
    list_item: {
      content: "paragraph block*",
      attrs: {
        label: { default: "•" },
        listType: { default: "bullet" },
        spread: { default: true },
        checked: { default: null },
      },
    },
    text: {},
  },
});

const p = (text?: string): Node =>
  schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
const item = (content: Node | Node[], checked: boolean | null = null): Node =>
  schema.nodes.list_item.create({ checked }, content);
const ul = (...items: Node[]): Node => schema.nodes.bullet_list.create(null, items);
const ol = (...items: Node[]): Node => schema.nodes.ordered_list.create(null, items);
const doc = (...blocks: Node[]): Node => schema.nodes.doc.create(null, blocks);

function stateAt(document: Node, from: number, to = from): EditorState {
  return EditorState.create({
    doc: document,
    selection: TextSelection.create(document, from, to),
  });
}

/** コマンドを撃ち、書き換わった state と「受けたかどうか」を返す。 */
function apply(state: EditorState, command: Command): { next: EditorState; handled: boolean } {
  let next = state;
  const handled = command(state, (tr) => {
    next = state.apply(tr);
  });
  return { next, handled };
}

/** 文書の骨組みを一行で。属性は checked だけ添える。 */
function outline(node: Node): string {
  if (node.isText) {
    return JSON.stringify(node.text);
  }
  const checked =
    node.attrs.checked === undefined || node.attrs.checked === null
      ? ""
      : `[${node.attrs.checked}]`;
  const children: string[] = [];
  node.forEach((child) => children.push(outline(child)));
  return `${node.type.name}${checked}(${children.join(" ")})`;
}

describe("splitTaskItem", () => {
  // doc(1 ul(1 li(1 p "done"
  it("starts the next item unchecked when Enter is pressed at the end of a checked item", () => {
    const state = stateAt(doc(ul(item(p("done"), true))), 7);

    const { next, handled } = apply(state, splitTaskItem);

    expect(handled).toBe(true);
    expect(outline(next.doc)).toBe(
      'doc(bullet_list(list_item[true](paragraph("done")) list_item[false](paragraph())))',
    );
    expect(next.selection.$from.node(-1).attrs.checked).toBe(false);
  });

  it("keeps the check on the text when Enter is pressed at the start of a checked item", () => {
    const state = stateAt(doc(ul(item(p("done"), true))), 3);

    const { next } = apply(state, splitTaskItem);

    expect(outline(next.doc)).toBe(
      'doc(bullet_list(list_item[false](paragraph()) list_item[true](paragraph("done"))))',
    );
  });

  it("falls through when a top-level rule is selected instead of text", () => {
    // doc(1 p "a" 3) hr(3
    const document = doc(p("a"), schema.nodes.hr.create());
    const state = EditorState.create({
      doc: document,
      selection: NodeSelection.create(document, 3),
    });

    expect(apply(state, splitTaskItem).handled).toBe(false);
    expect(apply(state, liftItemAtStart).handled).toBe(false);
  });

  it("leaves a plain list item to the default Enter", () => {
    const state = stateAt(doc(ul(item(p("one")))), 6);

    expect(apply(state, splitTaskItem).handled).toBe(false);
  });

  it("leaves an unchecked task item to the default Enter, which already copies false", () => {
    const state = stateAt(doc(ul(item(p("todo"), false))), 7);

    expect(apply(state, splitTaskItem).handled).toBe(false);
  });

  it("leaves an empty checked item to the default Enter, which lifts it out", () => {
    const state = stateAt(doc(ul(item(p("a"), true), item(p(), true))), 8);

    expect(apply(state, splitTaskItem).handled).toBe(false);
  });
});

describe("liftItemAtStart", () => {
  it("turns the item into a paragraph when Backspace is pressed at its start", () => {
    // doc(1 ul(1 li(1 p "one" 6)7 li(8 p(9 "two"
    const state = stateAt(doc(ul(item(p("one")), item(p("two")))), 10);

    const { next, handled } = apply(state, liftItemAtStart);

    expect(handled).toBe(true);
    expect(outline(next.doc)).toBe(
      'doc(bullet_list(list_item(paragraph("one"))) paragraph("two"))',
    );
  });

  it("lifts a nested item one level, like Shift-Tab", () => {
    // doc(1 ul(1 li(1 p "one" 6)7 ul(8 li(9 p(10 "two"
    const state = stateAt(doc(ul(item([p("one"), ul(item(p("two")))]))), 10);

    const { next } = apply(state, liftItemAtStart);

    expect(outline(next.doc)).toBe(
      'doc(bullet_list(list_item(paragraph("one")) list_item(paragraph("two"))))',
    );
  });

  it("does nothing away from the start of the item", () => {
    const state = stateAt(doc(ul(item(p("one")), item(p("two")))), 11);

    expect(apply(state, liftItemAtStart).handled).toBe(false);
  });

  it("does nothing in an item's second paragraph", () => {
    // doc(1 ul(1 li(1 p "one" 6) p(7
    const state = stateAt(doc(ul(item([p("one"), p("two")]))), 8);

    expect(apply(state, liftItemAtStart).handled).toBe(false);
  });

  it("does nothing outside a list or with a range selected", () => {
    expect(apply(stateAt(doc(p("one")), 1), liftItemAtStart).handled).toBe(false);
    expect(apply(stateAt(doc(ul(item(p("one")))), 3, 5), liftItemAtStart).handled).toBe(false);
  });
});

describe("toggleBulletList", () => {
  it("wraps a paragraph into a bullet list", () => {
    const { next } = apply(stateAt(doc(p("one")), 2), toggleBulletList);

    expect(outline(next.doc)).toBe('doc(bullet_list(list_item(paragraph("one"))))');
  });

  it("lifts the item back out when it is already a bullet", () => {
    const { next } = apply(stateAt(doc(ul(item(p("one")))), 4), toggleBulletList);

    expect(outline(next.doc)).toBe('doc(paragraph("one"))');
  });

  it("turns an ordered list into a bullet list, items included", () => {
    const ordered = schema.nodes.list_item.create({ listType: "ordered", label: "1." }, p("one"));
    const { next } = apply(stateAt(doc(ol(ordered)), 4), toggleBulletList);

    expect(outline(next.doc)).toBe('doc(bullet_list(list_item(paragraph("one"))))');
    // syncListOrderPlugin は listType が ordered の bullet_list を番号付きに戻す
    expect(next.doc.firstChild?.firstChild?.attrs.listType).toBe("bullet");
  });
});

describe("toggleOrderedList", () => {
  it("wraps a paragraph into an ordered list", () => {
    const { next } = apply(stateAt(doc(p("one")), 2), toggleOrderedList);

    expect(outline(next.doc)).toBe('doc(ordered_list(list_item(paragraph("one"))))');
  });

  it("turns a bullet list into an ordered list, items included", () => {
    const { next } = apply(stateAt(doc(ul(item(p("one")))), 4), toggleOrderedList);

    expect(outline(next.doc)).toBe('doc(ordered_list(list_item(paragraph("one"))))');
    expect(next.doc.firstChild?.firstChild?.attrs.listType).toBe("ordered");
  });

  it("lifts the item back out when it is already numbered", () => {
    const { next } = apply(stateAt(doc(ol(item(p("one")))), 4), toggleOrderedList);

    expect(outline(next.doc)).toBe('doc(paragraph("one"))');
  });
});

describe("toggleTaskItem", () => {
  it("wraps a paragraph into an unchecked task", () => {
    const { next } = apply(stateAt(doc(p("one")), 2), toggleTaskItem);

    expect(outline(next.doc)).toBe('doc(bullet_list(list_item[false](paragraph("one"))))');
  });

  it("gives a bullet item a box", () => {
    const { next } = apply(stateAt(doc(ul(item(p("one")))), 4), toggleTaskItem);

    expect(outline(next.doc)).toBe('doc(bullet_list(list_item[false](paragraph("one"))))');
  });

  it("takes the box away from a task item, checked or not", () => {
    for (const checked of [true, false]) {
      const { next } = apply(stateAt(doc(ul(item(p("one"), checked))), 4), toggleTaskItem);
      expect(outline(next.doc)).toBe('doc(bullet_list(list_item(paragraph("one"))))');
    }
  });

  it("touches only the innermost item when the cursor is in a nested one", () => {
    // doc(1 ul(1 li(1 p "one" 6)7 ul(8 li(9 p(10 "two"
    const state = stateAt(doc(ul(item([p("one"), ul(item(p("two")))]))), 11);

    const { next } = apply(state, toggleTaskItem);

    expect(outline(next.doc)).toBe(
      'doc(bullet_list(list_item(paragraph("one") bullet_list(list_item[false](paragraph("two"))))))',
    );
  });

  it("marks the containing item from its second paragraph", () => {
    // doc(1 ul(1 li(1 p "one" 6)7 p(8 "two"
    const state = stateAt(doc(ul(item([p("one"), p("two")]))), 9);

    const { next } = apply(state, toggleTaskItem);

    expect(outline(next.doc)).toBe(
      'doc(bullet_list(list_item[false](paragraph("one") paragraph("two"))))',
    );
  });

  it("makes every selected paragraph a task, not just the first", () => {
    // doc(1 p "one" 6 p(7 "two"
    const state = stateAt(doc(p("one"), p("two")), 2, 8);

    const { next } = apply(state, toggleTaskItem);

    expect(outline(next.doc)).toBe(
      'doc(bullet_list(list_item[false](paragraph("one")) list_item[false](paragraph("two"))))',
    );
  });

  it("keeps a numbered item numbered", () => {
    const { next } = apply(stateAt(doc(ol(item(p("one")))), 4), toggleTaskItem);

    expect(outline(next.doc)).toBe('doc(ordered_list(list_item[false](paragraph("one"))))');
  });
});
