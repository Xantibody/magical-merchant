import { describe, it, expect } from "vitest";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection, NodeSelection } from "@milkdown/kit/prose/state";
import type { Node } from "@milkdown/kit/prose/model";
import {
  deleteCurrentBlock,
  exitCodeBlock,
  indentCodeLine,
  outdentCodeLine,
  stepPastHr,
} from "./block-commands";

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

describe("indentCodeLine", () => {
  it("inserts two spaces where the cursor is in a code block", () => {
    const doc = schema.nodes.doc.create(null, [code("a\nb")]);
    // code の中は 1 始まり。"a\n" の後ろ = 3
    const state = stateAt(doc, 3);

    const next = apply(state, indentCodeLine);

    expect(next.doc.textContent).toBe("a\n  b");
    expect(next.selection.from).toBe(5);
  });

  it("is not for paragraphs", () => {
    const state = stateAt(schema.nodes.doc.create(null, [p("text")]), 2);

    expect(indentCodeLine(state)).toBe(false);
  });
});

describe("outdentCodeLine", () => {
  it("removes one level of indentation at the start of the cursor's line", () => {
    const doc = schema.nodes.doc.create(null, [code("a\n    b")]);
    // 4 スペースの後ろ = 7
    const state = stateAt(doc, 7);

    const next = apply(state, outdentCodeLine);

    expect(next.doc.textContent).toBe("a\n  b");
    expect(next.selection.from).toBe(5);
  });

  it("removes a tab too", () => {
    const doc = schema.nodes.doc.create(null, [code("\tb")]);
    const state = stateAt(doc, 3);

    expect(apply(state, outdentCodeLine).doc.textContent).toBe("b");
  });

  it("still claims the key when there is nothing to remove", () => {
    const doc = schema.nodes.doc.create(null, [code("b")]);
    const state = stateAt(doc, 2);

    expect(outdentCodeLine(state)).toBe(true);
    expect(apply(state, outdentCodeLine).doc.textContent).toBe("b");
  });

  it("is not for paragraphs", () => {
    const state = stateAt(schema.nodes.doc.create(null, [p("  text")]), 3);

    expect(outdentCodeLine(state)).toBe(false);
  });
});

/** stepPastHr が直すべきものを見つけた前提で、その結果の state。 */
function applyStep(state: EditorState): EditorState {
  const tr = stepPastHr(state);
  if (!tr) {
    throw new Error("stepPastHr found nothing to fix");
  }
  return state.apply(tr);
}

describe("stepPastHr", () => {
  it("moves a selected horizontal rule's cursor into a fresh paragraph below it", () => {
    const doc = schema.nodes.doc.create(null, [p("a"), schema.nodes.hr.create()]);
    const state = EditorState.create({ doc, selection: NodeSelection.create(doc, 3) });

    const next = applyStep(state);

    expect(next.doc.childCount).toBe(3);
    expect(next.doc.lastChild?.type.name).toBe("paragraph");
    expect(next.selection instanceof TextSelection).toBe(true);
    expect(next.selection.$from.parent).toBe(next.doc.lastChild);
  });

  it("leaves a text cursor and other node selections alone", () => {
    const doc = schema.nodes.doc.create(null, [p("a"), schema.nodes.hr.create(), code("x")]);

    expect(stepPastHr(stateAt(doc, 1))).toBeNull();
    expect(
      stepPastHr(EditorState.create({ doc, selection: NodeSelection.create(doc, 4) })),
    ).toBeNull();
  });
});
