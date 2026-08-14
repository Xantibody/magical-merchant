import { describe, it, expect } from "vitest";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection, NodeSelection } from "@milkdown/kit/prose/state";
import type { Node } from "@milkdown/kit/prose/model";
import { deleteCurrentBlock, exitCodeBlock } from "./block-commands";

// 本物の commonmark スキーマは Milkdown の初期化ごと必要になる。コマンドが
// 見るのはノード名と入れ子だけなので、その形だけを再現した最小スキーマで足りる。
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*" },
    code_block: { group: "block", content: "text*", code: true },
    hr: { group: "block" },
    bullet_list: { group: "block", content: "list_item+" },
    list_item: { content: "paragraph block*" },
    text: {},
  },
});

const p = (text?: string): Node =>
  schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
const code = (text: string): Node => schema.nodes.code_block.create(null, schema.text(text));

/** pos にカーソルを置いた state。 */
function stateAt(doc: Node, pos: number): EditorState {
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
}

function apply(state: EditorState, command: typeof deleteCurrentBlock): EditorState {
  let next = state;
  command(state, (tr) => {
    next = state.apply(tr);
  });
  return next;
}

describe("deleteCurrentBlock", () => {
  it("removes the whole code block the cursor is in", () => {
    const doc = schema.nodes.doc.create(null, [p("before"), code("fn main() {}"), p("after")]);
    // "before"(8) + 開始タグで code 内の先頭は 9
    const state = stateAt(doc, 10);

    const next = apply(state, deleteCurrentBlock);

    expect(next.doc.childCount).toBe(2);
    expect(next.doc.textContent).toBe("beforeafter");
  });

  it("removes only the paragraph the cursor is in", () => {
    const doc = schema.nodes.doc.create(null, [p("one"), p("two")]);
    const state = stateAt(doc, 2);

    const next = apply(state, deleteCurrentBlock);

    expect(next.doc.childCount).toBe(1);
    expect(next.doc.textContent).toBe("two");
  });

  it("removes a node selection such as a horizontal rule", () => {
    const doc = schema.nodes.doc.create(null, [p("a"), schema.nodes.hr.create(), p("b")]);
    const state = EditorState.create({ doc, selection: NodeSelection.create(doc, 3) });

    const next = apply(state, deleteCurrentBlock);

    expect(next.doc.childCount).toBe(2);
    expect(next.doc.firstChild?.type.name).toBe("paragraph");
  });

  it("leaves an empty paragraph instead of an empty document", () => {
    const doc = schema.nodes.doc.create(null, [code("only block")]);
    const state = stateAt(doc, 1);

    const next = apply(state, deleteCurrentBlock);

    expect(next.doc.childCount).toBe(1);
    expect(next.doc.firstChild?.type.name).toBe("paragraph");
    expect(next.doc.textContent).toBe("");
  });

  it("takes the surrounding list item along when its only paragraph goes", () => {
    const li = schema.nodes.list_item.create(null, p("item"));
    const doc = schema.nodes.doc.create(null, [schema.nodes.bullet_list.create(null, li), p("x")]);
    const state = stateAt(doc, 3);

    const next = apply(state, deleteCurrentBlock);

    expect(next.doc.textContent).toBe("x");
  });
});

describe("exitCodeBlock", () => {
  it("puts the cursor into a fresh paragraph after the code block", () => {
    const doc = schema.nodes.doc.create(null, [code("code")]);
    const state = stateAt(doc, 1);

    const next = apply(state, exitCodeBlock);

    expect(next.doc.childCount).toBe(2);
    expect(next.doc.lastChild?.type.name).toBe("paragraph");
    expect(next.selection.$from.parent.type.name).toBe("paragraph");
  });

  it("does nothing outside a code block", () => {
    const doc = schema.nodes.doc.create(null, [p("plain")]);
    const state = stateAt(doc, 2);

    expect(exitCodeBlock(state)).toBe(false);
  });
});
