import "../index.css";
import { render, cleanup } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { editorViewCtx, serializerCtx } from "@milkdown/kit/core";
import type { Editor } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import MilkdownEditor from "./MilkdownEditor";
import type { VimMode } from "../lib/vim-keys";

async function mount(source: string, vim = true) {
  let editor: Editor | undefined;
  const modes: VimMode[] = [];
  render(() => (
    <MilkdownEditor
      defaultValue={source}
      vim={vim}
      onVimMode={(mode) => modes.push(mode)}
      onEditorReady={(value) => {
        editor = value;
      }}
      noteLinks={() => [{ id: "20260920_120000", title: "Linked note" }]}
    />
  ));
  await expect.poll(() => editor, { timeout: 10_000 }).toBeDefined();
  const created = editor;
  if (!created) {
    throw new Error("Editor did not mount");
  }
  const view = created.action((ctx) => ctx.get(editorViewCtx));
  /** Put the caret `offset` characters into the first text node that holds `text`. */
  const caretIn = (text: string, offset = 0) => {
    let pos = -1;
    view.state.doc.descendants((node, at) => {
      if (pos === -1 && node.isText && node.text?.includes(text)) {
        pos = at + (node.text.indexOf(text) ?? 0) + offset;
      }
    });
    expect(pos).toBeGreaterThan(-1);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
    view.focus();
  };
  const markdown = () => created.action((ctx) => ctx.get(serializerCtx)(view.state.doc)).trim();
  /** The character under the block cursor, or "" on an empty line. */
  const under = () => {
    const { head } = view.state.selection;
    return view.state.doc.textBetween(head, Math.min(head + 1, view.state.selection.$head.end()));
  };
  const selected = () => {
    const { from, to } = view.state.selection;
    return view.state.doc.textBetween(from, to, "\n");
  };
  const mode = () => modes.at(-1) ?? "insert";
  return { view, caretIn, markdown, under, selected, mode };
}

const press = (keys: string) => userEvent.keyboard(keys);

/** In normal mode with the block cursor on the character `offset` into `text`. */
async function normalAt(source: string, text: string, offset = 0) {
  const ed = await mount(source);
  ed.caretIn(text, offset + 1);
  await press("{Escape}");
  return ed;
}

describe("Vim keys: modes", () => {
  afterEach(cleanup);

  it("starts in insert, so the first key typed is text", async () => {
    const ed = await mount("alpha");
    ed.caretIn("alpha", 5);

    await press("j");

    expect(ed.markdown()).toBe("alphaj");
    expect(ed.mode()).toBe("insert");
  });

  it("enters normal on Esc and steps back onto the last character", async () => {
    const ed = await mount("alpha");
    ed.caretIn("alpha", 5);

    await press("{Escape}");

    expect(ed.mode()).toBe("normal");
    expect(ed.under()).toBe("a");
    expect(ed.view.state.selection.head).toBe(5);
  });

  it("takes every typing key in normal without touching the text", async () => {
    const ed = await mount("alpha");
    ed.caretIn("alpha", 2);
    await press("{Escape}");

    await press("qzZ {Enter}{Backspace}{Delete}{Tab}");

    expect(ed.markdown()).toBe("alpha");
  });

  it("leaves the editor alone when the setting is off", async () => {
    const ed = await mount("alpha", false);
    ed.caretIn("alpha", 5);

    await press("{Escape}j");

    expect(ed.markdown()).toBe("alphaj");
  });

  // Vim's reflex is to press Esc again. It must not move the cursor or leave normal
  it("stays put on a second Esc", async () => {
    const ed = await mount("alpha");
    ed.caretIn("alpha", 2);
    await press("{Escape}");
    const { head } = ed.view.state.selection;

    await press("{Escape}");

    expect(ed.mode()).toBe("normal");
    expect(ed.view.state.selection.head).toBe(head);
  });

  it("lets the link completion take Esc before Vim does", async () => {
    const ed = await mount("alpha");
    ed.caretIn("alpha", 5);

    await press(" [[[[Lin");
    await expect
      .poll(() => document.querySelector<HTMLElement>(".note-link-suggest")?.style.display)
      .toBe("block");
    await press("{Escape}");

    expect(ed.mode()).toBe("insert");
  });

  it("draws one block cursor in normal and none in insert", async () => {
    const ed = await mount("alpha\n\nbeta");
    ed.caretIn("alpha", 0);
    expect(ed.view.dom.querySelectorAll(".vim-cursor")).toHaveLength(0);

    await press("{Escape}");

    expect(ed.view.dom.querySelectorAll(".vim-cursor")).toHaveLength(1);
    expect(ed.view.dom.classList.contains("vim-normal")).toBe(true);
  });
});

describe("Vim keys: motions", () => {
  afterEach(cleanup);

  it("moves by a character with h and l, inside the line", async () => {
    const ed = await normalAt("abc", "abc", 1);

    await press("l");
    expect(ed.under()).toBe("c");
    await press("l");
    expect(ed.under()).toBe("c");
    await press("hhh");
    expect(ed.under()).toBe("a");
  });

  it("goes to the ends of the line with 0 and $", async () => {
    const ed = await normalAt("alpha beta", "alpha", 2);

    await press("$");
    expect(ed.under()).toBe("a");
    expect(ed.view.state.selection.head).toBe(10);
    await press("0");
    expect(ed.view.state.selection.head).toBe(1);
  });

  it("goes to the first and the last line with gg and G", async () => {
    const ed = await normalAt("first\n\nmiddle\n\nlast", "middle", 2);

    await press("G");
    expect(ed.under()).toBe("l");
    await press("gg");
    expect(ed.under()).toBe("f");
  });

  it("moves between lines with j and k", async () => {
    const ed = await normalAt("one\n\ntwo\n\nthree", "two", 0);

    await press("j");
    expect(ed.under()).toBe("t");
    expect(ed.view.state.selection.$head.parent.textContent).toBe("three");
    await press("kk");
    expect(ed.view.state.selection.$head.parent.textContent).toBe("one");
  });

  it("moves by words with w and b", async () => {
    const ed = await normalAt("alpha beta gamma", "alpha", 0);

    await press("w");
    expect(ed.under()).toBe("b");
    await press("w");
    expect(ed.under()).toBe("g");
    await press("b");
    expect(ed.under()).toBe("b");
  });

  it("treats a line of a code block as a line", async () => {
    const ed = await normalAt("```\nfirst\nsecond\n```", "second", 2);

    await press("0");
    expect(ed.under()).toBe("s");
    await press("$");
    expect(ed.under()).toBe("d");
  });
});

describe("Vim keys: into insert", () => {
  afterEach(cleanup);

  it.each([
    ["i", "aXbc"],
    ["a", "abXc"],
    ["I", "Xabc"],
    ["A", "abcX"],
  ])("%s places the caret where Vim does", async (k, expected) => {
    const ed = await normalAt("abc", "abc", 1);

    await press(`${k}X`);

    expect(ed.mode()).toBe("insert");
    expect(ed.markdown()).toBe(expected);
  });

  it("opens a line below with o and above with O", async () => {
    const ed = await normalAt("one\n\ntwo", "one", 0);

    await press("onew");
    expect(ed.markdown()).toBe("one\n\nnew\n\ntwo");
    await press("{Escape}gg");
    await press("Otop");
    expect(ed.markdown()).toBe("top\n\none\n\nnew\n\ntwo");
  });

  it("opens a new item inside a list", async () => {
    const ed = await normalAt("- one\n- two", "one", 0);

    await press("onew");

    expect(ed.markdown()).toBe("* one\n* new\n* two");
  });
});

describe("Vim keys: edits", () => {
  afterEach(cleanup);

  it("deletes the character under the cursor with x", async () => {
    const ed = await normalAt("abc", "abc", 1);

    await press("x");

    expect(ed.markdown()).toBe("ac");
    expect(ed.under()).toBe("c");
  });

  it("does nothing with x on an empty line", async () => {
    const ed = await normalAt("one\n\n<br />\n\ntwo", "one", 0);
    const before = ed.markdown();
    await press("j");

    await press("x");

    expect(ed.markdown()).toBe(before);
  });

  it("deletes a line with dd and puts it back below with p", async () => {
    const ed = await normalAt("one\n\ntwo\n\nthree", "one", 0);

    await press("dd");
    expect(ed.markdown()).toBe("two\n\nthree");
    expect(ed.under()).toBe("t");

    await press("p");
    expect(ed.markdown()).toBe("two\n\none\n\nthree");
  });

  it("copies a line with yy and puts it above with P", async () => {
    const ed = await normalAt("one\n\ntwo", "two", 0);

    await press("yyP");

    expect(ed.markdown()).toBe("one\n\ntwo\n\ntwo");
  });

  it("deletes the only line and leaves an empty document", async () => {
    const ed = await normalAt("only", "only", 0);

    await press("dd");

    expect(ed.markdown()).toBe("");
  });

  it("deletes a list item, and the list with its last item", async () => {
    const ed = await normalAt("- one\n- two\n\nafter", "one", 0);

    await press("dd");
    expect(ed.markdown()).toBe("* two\n\nafter");
    await press("dd");
    expect(ed.markdown()).toBe("after");
  });

  it("deletes one line of a code block, not the block", async () => {
    const ed = await normalAt("```\nfirst\nsecond\n```", "first", 0);

    await press("dd");

    expect(ed.markdown()).toBe("```\nsecond\n```");
  });

  it("undoes with u and redoes with Ctrl-r", async () => {
    const ed = await normalAt("one\n\ntwo", "one", 0);
    await press("dd");

    await press("u");
    expect(ed.markdown()).toBe("one\n\ntwo");
    await press("{Control>}r{/Control}");
    expect(ed.markdown()).toBe("two");
  });

  it("does nothing on p with nothing kept", async () => {
    const ed = await normalAt("one", "one", 0);

    await press("p");

    expect(ed.markdown()).toBe("one");
  });
});

describe("Vim keys: visual", () => {
  afterEach(cleanup);

  it("selects the characters under both ends with v", async () => {
    const ed = await normalAt("alpha beta", "alpha", 1);

    await press("vll");

    expect(ed.mode()).toBe("visual");
    expect(ed.selected()).toBe("lph");
  });

  it("deletes the selection with d and keeps it for p", async () => {
    const ed = await normalAt("alpha beta", "alpha", 1);

    await press("vlld");
    expect(ed.markdown()).toBe("aa beta");
    expect(ed.mode()).toBe("normal");

    await press("$p");
    expect(ed.markdown()).toBe("aa betalph");
  });

  it("changes the selection with c", async () => {
    const ed = await normalAt("alpha beta.", "beta", 0);

    await press("vlllcX");

    expect(ed.mode()).toBe("insert");
    expect(ed.markdown()).toBe("alpha X.");
  });

  it("selects whole lines with V and deletes them", async () => {
    const ed = await normalAt("one\n\ntwo\n\nthree", "one", 1);

    await press("Vj");
    expect(ed.mode()).toBe("visual-line");
    expect(ed.selected()).toBe("one\ntwo");
    await press("d");

    expect(ed.markdown()).toBe("three");
  });

  it("yanks with y and returns to normal at the start", async () => {
    const ed = await normalAt("one\n\ntwo", "one", 0);

    await press("Vjy");

    expect(ed.mode()).toBe("normal");
    expect(ed.markdown()).toBe("one\n\ntwo");
    expect(ed.under()).toBe("o");
  });

  it("leaves visual with Esc and with v again", async () => {
    const ed = await normalAt("alpha", "alpha", 0);

    await press("vl{Escape}");
    expect(ed.mode()).toBe("normal");
    await press("vlv");
    expect(ed.mode()).toBe("normal");
    expect(ed.selected()).toBe("");
  });
});

describe("Vim keys: what does not come through the keys", () => {
  afterEach(cleanup);

  it("refuses a paste in normal", async () => {
    const ed = await normalAt("alpha", "alpha", 0);
    const data = new DataTransfer();
    data.setData("text/plain", "pasted");

    ed.view.dom.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );

    expect(ed.markdown()).toBe("alpha");
  });

  it("takes a paste in insert as usual", async () => {
    const ed = await mount("alpha");
    ed.caretIn("alpha", 5);
    const data = new DataTransfer();
    data.setData("text/plain", "!");

    ed.view.dom.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );

    expect(ed.markdown()).toBe("alpha!");
  });

  // The browser's own edits (an emacs-style Ctrl-K on a Mac, dictation) arrive as beforeinput
  it("cancels the browser's own edits in normal", async () => {
    const ed = await normalAt("alpha", "alpha", 0);
    const input = new InputEvent("beforeinput", {
      inputType: "deleteSoftLineForward",
      bubbles: true,
      cancelable: true,
    });

    ed.view.dom.dispatchEvent(input);

    expect(input.defaultPrevented).toBe(true);
  });
});

describe("Vim keys: review fixes", () => {
  afterEach(cleanup);

  it("deletes whole lines of a code block with V d, newlines included", async () => {
    const ed = await normalAt("```\nfirst\nsecond\nthird\n```", "second", 0);

    await press("Vd");

    expect(ed.markdown()).toBe("```\nfirst\nthird\n```");
  });

  it("deletes the last line of a code block with V d", async () => {
    const ed = await normalAt("```\nfirst\nsecond\n```", "second", 0);

    await press("Vd");

    expect(ed.markdown()).toBe("```\nfirst\n```");
  });

  it("deletes a code block whose only line is taken with V d, as dd does", async () => {
    const ed = await normalAt("before\n\n```\nonly\n```\n\nafter", "only", 0);

    await press("Vd");

    expect(ed.markdown()).toBe("before\n\nafter");
  });

  // Vim's V c leaves one empty line to write the replacement on
  it("changes whole lines into one empty line with V c", async () => {
    const ed = await normalAt("one\n\ntwo\n\nthree", "one", 0);

    await press("VjcX");

    expect(ed.mode()).toBe("insert");
    expect(ed.markdown()).toBe("X\n\nthree");
  });

  it("changes code lines into one empty line with V c", async () => {
    const ed = await normalAt("```\nfirst\nsecond\nthird\n```", "second", 0);

    await press("VcX");

    expect(ed.markdown()).toBe("```\nfirst\nX\nthird\n```");
  });
});
