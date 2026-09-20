import { it, expect } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { createGlyphPlugin } from "./glyph-plugin";
import { createNoteLinkPlugin } from "./note-link-plugin";

async function mount(body: string) {
  const root = document.createElement("div");
  document.body.append(root);
  const registry = new Map([
    ["star", "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"],
  ]);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, body);
    })
    .use(commonmark)
    .use(createGlyphPlugin(() => registry))
    .use(createNoteLinkPlugin(() => [{ id: "20260920_120000", title: "Linked note" }]))
    .create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  return {
    root,
    view,
    async destroy() {
      await editor.destroy();
      root.remove();
    },
  };
}

it("audit: clicking a moved glyph must use its current position", async () => {
  const h = await mount("prefix :star: tail");
  try {
    expect(h.root.querySelector("img.glyph")).not.toBeNull();
    h.view.dispatch(h.view.state.tr.insertText("0123456789", 1));
    const glyph = h.root.querySelector("img.glyph")!;
    glyph.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(h.view.state.selection.from).toBe(19);
  } finally {
    await h.destroy();
  }
});

it("audit: fenced code must not turn glyph source into an image", async () => {
  const h = await mount("intro\n\n```text\n:star:\n```");
  try {
    expect(h.root.querySelector("pre img.glyph")).toBeNull();
  } finally {
    await h.destroy();
  }
});

it("audit: inline code must not turn a note ID into a link chip", async () => {
  const h = await mount("intro `[[20260920_120000]]` tail");
  try {
    expect(h.root.querySelector(".note-link-chip")).toBeNull();
  } finally {
    await h.destroy();
  }
});
