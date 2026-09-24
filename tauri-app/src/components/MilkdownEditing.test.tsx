import "../index.css";
import { render, cleanup, fireEvent, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { editorViewCtx, parserCtx, serializerCtx } from "@milkdown/kit/core";
import type { Editor } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import MilkdownEditor from "./MilkdownEditor";

const TABLE = "| H1 | H2 |\n| --- | --- |\n| a | b |";
async function mount(source: string) {
  let editor: Editor | undefined;
  const changes: string[] = [];
  const { container } = render(() => (
    <MilkdownEditor
      defaultValue={source}
      onChange={(text) => changes.push(text)}
      onEditorReady={(value) => {
        editor = value;
      }}
      glyphs={() =>
        new Map([["star", "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"]])
      }
      noteLinks={() => [{ id: "20260920_120000", title: "Linked note" }]}
    />
  ));
  await expect.poll(() => editor, { timeout: 10_000 }).toBeDefined();
  const created = editor;
  if (!created) {
    throw new Error("Editor did not mount");
  }
  const view = created.action((ctx) => ctx.get(editorViewCtx));
  const select = (text: string, end = false) => {
    let pos = -1;
    view.state.doc.descendants((node, at) => {
      if (node.isText && node.text === text) {
        pos = at + (end ? text.length : 0);
      }
    });
    expect(pos).toBeGreaterThan(-1);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
    view.focus();
  };
  const roundtrip = () =>
    created.action((ctx) => {
      const doc = ctx.get(parserCtx)(ctx.get(serializerCtx)(view.state.doc));
      if (!doc) {
        throw new Error("Markdown did not parse");
      }
      return doc;
    });
  const markdown = () => created.action((ctx) => ctx.get(serializerCtx)(view.state.doc));
  return { container, view, select, changes, roundtrip, markdown };
}

async function tableAction(label: string) {
  await userEvent.click(screen.getByRole("button", { name: "表", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: label, exact: true }));
}

describe("Note table editing and inline decorations", () => {
  afterEach(cleanup);

  it("keeps table controls beside the selected row and marks its row and column only while open", async () => {
    const h = await mount(`${TABLE}\n| c | d |\n| e | f |\n\nAfter the table`);
    h.select("d");
    const button = screen.getByRole("button", { name: "表", exact: true });
    const cell = screen.getByRole("cell", { name: "d", exact: true });
    await expect
      .poll(() => {
        const a = button.getBoundingClientRect();
        const b = cell.getBoundingClientRect();
        return Math.abs(a.top + a.height / 2 - (b.top + b.height / 2));
      })
      .toBeLessThan(2);
    const before = h.view.state.doc;
    const { selection } = h.view.state;
    await userEvent.click(button);
    await expect.poll(() => h.container.querySelectorAll(".table-menu-target").length).toBe(5);
    expect(h.view.state.selection.eq(selection)).toBe(true);
    expect(h.view.state.doc.eq(before)).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(h.container.querySelectorAll(".table-menu-target")).toHaveLength(0);
    h.select("After the table");
    await expect
      .poll(() => button.closest(".editor-table-tools")?.classList.contains("is-contextual"))
      .toBe(false);
  });

  it.each([
    ["上に行を追加", ["H1", "a", "", "c", "e"]],
    ["下に行を追加", ["H1", "a", "c", "", "e"]],
  ])("%s preserves the surrounding rows when inserting in the middle", async (label, expected) => {
    const h = await mount(`${TABLE}\n| c | d |\n| e | f |`);
    h.select("c");
    await tableAction(label);
    const table = h.roundtrip().child(0);
    expect(
      Array.from({ length: table.childCount }, (_, row) => table.child(row).child(0).textContent),
    ).toStrictEqual(expected);
  });

  it("tracks a scrolling row and fits the menu in a phone viewport with the keyboard open", async () => {
    await page.viewport(390, 320);
    try {
      const h = await mount(`${TABLE}\n| c | d |\n| e | f |\n\nAfter the table`);
      h.container.style.cssText = "height: 240px; overflow: auto; margin-top: 40px";
      const cell = screen.getByRole("cell", { name: "d", exact: true });
      await userEvent.click(cell);
      const button = screen.getByRole("button", { name: "表", exact: true });
      await expect
        .poll(() => button.closest(".editor-table-tools")?.classList.contains("is-contextual"))
        .toBe(true);
      await expect
        .poll(() =>
          Math.abs(
            button.getBoundingClientRect().top +
              22 -
              (cell.getBoundingClientRect().top + cell.getBoundingClientRect().height / 2),
          ),
        )
        .toBeLessThan(2);
      h.container.scrollTop = 30;
      await expect
        .poll(() =>
          Math.abs(
            button.getBoundingClientRect().top +
              22 -
              (cell.getBoundingClientRect().top + cell.getBoundingClientRect().height / 2),
          ),
        )
        .toBeLessThan(2);
      expect(button.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
      expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(
        screen.getByRole("table").getBoundingClientRect().left + 1,
      );
      await userEvent.click(button);
      const menu = screen.getByRole("dialog", { name: "表" });
      await expect.poll(() => menu.getBoundingClientRect().bottom).toBeLessThanOrEqual(320);
      expect(menu.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
      expect(menu.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
      expect(menu.getBoundingClientRect().right).toBeLessThanOrEqual(390);
      await userEvent.click(screen.getByRole("button", { name: "下に行を追加", exact: true }));
      expect(h.roundtrip().child(0).childCount).toBe(5);
    } finally {
      await page.viewport(1280, 720);
    }
  });

  it("keeps the menu within a phone viewport and makes its last action reachable", async () => {
    await page.viewport(390, 720);
    const h = await mount(TABLE);
    h.select("a");
    await userEvent.click(screen.getByRole("button", { name: "表", exact: true }));
    const menu = screen.getByRole("dialog", { name: "表" });
    const rect = menu.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(390);
    await userEvent.click(screen.getByRole("button", { name: "表を削除", exact: true }));
    expect(h.container.querySelectorAll("table")).toHaveLength(0);
    await tableAction("元に戻す");
    expect(h.roundtrip().child(0).child(1).child(0).textContent).toBe("a");
    await page.viewport(1280, 720);
  });

  it("does not mutate a table while IME composition is active", async () => {
    const h = await mount(TABLE);
    h.select("b");
    const before = h.view.state.doc;
    fireEvent.compositionStart(h.view.dom);
    await tableAction("下に行を追加");
    expect(h.view.state.doc.eq(before)).toBe(true);
    fireEvent.keyDown(h.view.dom, { key: "Tab", isComposing: true, keyCode: 229 });
    expect(h.view.state.doc.eq(before)).toBe(true);
    fireEvent.compositionEnd(h.view.dom);
  });

  it("cell text can be typed and serialized", async () => {
    const h = await mount(TABLE);
    h.select("a", true);
    await userEvent.keyboard("X");
    expect(h.view.state.selection.$from.parent.textContent).toBe("aX");
    await expect.poll(() => h.changes.at(-1)).toContain("aX");
    expect(h.roundtrip().child(0).child(1).child(0).textContent).toBe("aX");
  });

  it("tab and Shift-Tab move between cells", async () => {
    const h = await mount(TABLE);
    h.select("a");
    await userEvent.keyboard("{Tab}");
    expect(h.view.state.selection.$from.parent.textContent).toBe("b");
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(h.view.state.selection.$from.parent.textContent).toBe("a");
  });

  it("tab at the last cell adds a row", async () => {
    const h = await mount(TABLE);
    h.select("b", true);
    await userEvent.keyboard("{Tab}");
    expect(h.view.state.selection.$from.parent.textContent).toBe("");
    expect(h.view.state.doc.child(0).childCount).toBe(3);
  });

  it("inserts a table from the menu and supports undo on touch", async () => {
    const h = await mount("");
    await tableAction("表を挿入");
    expect(h.container.querySelectorAll("table")).toHaveLength(1);
    await tableAction("元に戻す");
    expect(h.container.querySelectorAll("table")).toHaveLength(0);
  });

  it("adds and deletes rows and columns while keeping Markdown valid", async () => {
    const h = await mount(TABLE);
    h.select("a");
    await tableAction("下に行を追加");
    expect(h.view.state.doc.child(0).childCount).toBe(3);
    await tableAction("右に列を追加");
    expect(h.view.state.doc.child(0).child(0).childCount).toBe(3);
    await tableAction("列を削除");
    expect(h.view.state.doc.child(0).child(0).childCount).toBe(2);
    await tableAction("行を削除");
    expect(h.view.state.doc.child(0).childCount).toBe(2);
    expect(h.roundtrip().child(0).toJSON()).toStrictEqual(h.view.state.doc.child(0).toJSON());
  });

  it("protects the header and only body row, and keeps column alignment on Tab", async () => {
    const h = await mount(TABLE);
    h.select("H1");
    await userEvent.click(screen.getByRole("button", { name: "表", exact: true }));
    expect(screen.getByRole("button", { name: "上に行を追加" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "行を削除" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "中央揃え" }));
    h.select("b");
    await userEvent.keyboard("{Tab}");
    expect(h.view.state.doc.child(0).child(2).child(0).attrs.alignment).toBe("center");
    await tableAction("元に戻す");
    expect(h.view.state.doc.child(0).childCount).toBe(2);
    expect(h.view.state.doc.child(0).child(0).child(0).attrs.alignment).toBe("center");
  });

  it("closes the table menu with Escape while the editor keeps focus", async () => {
    const h = await mount(TABLE);
    h.select("a");
    await userEvent.click(screen.getByRole("button", { name: "表", exact: true }));
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "表", exact: true })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(h.view.hasFocus()).toBe(true);
  });

  it.each(["intro\n\n```text\n[[20260920_120000]]\n```", "intro `[[20260920_120000]]` tail"])(
    "keeps code links literal: %s",
    async (source) => {
      const h = await mount(source);
      expect(h.container.querySelector(".note-link-chip")).toBeNull();
      h.select("[[20260920_120000]]");
      h.view.dispatch(
        h.view.state.tr.setSelection(
          TextSelection.create(h.view.state.doc, h.view.state.selection.from + 2),
        ),
      );
      expect(
        [...document.querySelectorAll<HTMLElement>(".note-link-suggest")].every(
          (el) => el.style.display === "none",
        ),
      ).toBe(true);
    },
  );

  // A note link is not Markdown, so the serializer would escape it as text: `\\[\\[20260920\\_120000]]`
  // reads back the same, but the backlink search looks for the raw `[[ID`
  it.each([
    ["prev: [[20260920_120000]]", "prev: [[20260920_120000]]\n"],
    ["see [[20260920_120000|the old one]] here", "see [[20260920_120000|the old one]] here\n"],
    ["[x] and [[20260920_120000]] and a_b_", "\\[x] and [[20260920_120000]] and a\\_b\\_\n"],
  ])("writes a note link back unescaped: %s", async (source, expected) => {
    const h = await mount(source);
    expect(h.markdown()).toBe(expected);
  });

  it("each repeated glyph follows its own position after preceding deletion", async () => {
    const h = await mount("prefix :star: middle :star: tail");
    h.view.dispatch(h.view.state.tr.delete(1, 4));
    const images = h.container.querySelectorAll("img.glyph");
    expect(images).toHaveLength(2);
    fireEvent.mouseDown(images[1]);
    expect(h.view.state.selection.from).toBe(20);
  });

  it("the hidden table input rule creates a table", async () => {
    const h = await mount("");
    h.view.focus();
    await userEvent.keyboard("|2x2| ");
    expect(h.container.querySelectorAll("table")).toHaveLength(1);
  });

  it("shift-Enter in a cell survives serialization and reopening", async () => {
    const h = await mount(TABLE);
    h.select("a", true);
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}Z");
    expect(h.roundtrip().child(0).childCount).toBe(h.view.state.doc.child(0).childCount);
    expect(h.roundtrip().child(0).child(1).child(0).textContent).toBe("aZ");
    expect(h.roundtrip().child(0).toJSON()).toStrictEqual(h.view.state.doc.child(0).toJSON());
  });

  it("enter exits the table without losing cell text", async () => {
    const h = await mount(TABLE);
    h.select("a", true);
    await userEvent.keyboard("{Enter}Z");
    expect(h.view.state.selection.$from.depth).toBe(1);
    expect(h.view.state.doc.child(0).child(1).child(0).textContent).toBe("a");
    expect(h.roundtrip().textContent).toContain("Z");
  });

  it("pasted Markdown tables become editable cells", async () => {
    const h = await mount("");
    h.view.focus();
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", TABLE);
    h.view.dom.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
    );
    expect(h.container.querySelectorAll("table")).toHaveLength(1);
    h.select("a", true);
    await userEvent.keyboard("X");
    const doc = h.roundtrip();
    const tables = Array.from({ length: doc.childCount }, (_, index) => doc.child(index)).filter(
      (node) => node.type.name === "table",
    );
    expect(tables.map((node) => node.child(1).child(0).textContent)).toStrictEqual(["aX"]);
  });

  it("literal pipes in cells survive reopening", async () => {
    const h = await mount(TABLE);
    h.select("a", true);
    await userEvent.keyboard("|X");
    expect(h.roundtrip().child(0).child(1).child(0).textContent).toBe("a|X");
    expect(h.roundtrip().child(0).child(1).childCount).toBe(2);
  });

  it("fenced code does not become a glyph", async () => {
    const h = await mount("intro\n\n```text\n:star:\n```");
    expect(h.container.querySelector("pre img.glyph")).toBeNull();
  });

  it("clicking a glyph after preceding text was inserted uses its current position", async () => {
    const h = await mount("prefix :star: tail");
    h.view.dispatch(h.view.state.tr.insertText("0123456789", 1));
    fireEvent.mouseDown(screen.getByAltText(":star:"));
    expect(h.view.state.selection.from).toBe(19);
  });
});
