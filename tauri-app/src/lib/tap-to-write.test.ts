import { describe, it, expect, afterEach } from "vitest";
import { gapAt, placeCaret, placeCaretAfter, startsWriting, tapSpot } from "./tap-to-write";

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

/** The screen point of the character at `offset` in the first text node of `el`. */
function pointAt(el: Element, offset: number): { x: number; y: number } {
  const range = document.createRange();
  const text = el.firstChild;
  if (!text) {
    throw new Error("no text to point at");
  }
  range.setStart(text, offset);
  range.setEnd(text, offset + 1);
  const box = range.getBoundingClientRect();
  return { x: box.left + 1, y: box.top + box.height / 2 };
}

function click(target: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, button: 0, ...init });
  target.dispatchEvent(event);
  return event;
}

function clear(): void {
  document.body.innerHTML = "";
  globalThis.getSelection()?.removeAllRanges();
}

describe("startsWriting", () => {
  afterEach(clear);

  it("takes a plain tap on the page's text", () => {
    const root = mount("<p>本文</p>");
    const p = root.querySelector("p") as HTMLElement;
    let starts = false;
    p.addEventListener("click", (e) => {
      starts = startsWriting(e);
    });

    click(p);

    expect(starts).toBe(true);
  });

  // Links, checkboxes, code copy, tags and diagrams answer a tap themselves
  it.each([
    ['<a class="note-link">リンク</a>', "a"],
    ['<input type="checkbox" />', "input"],
    ['<div class="preview-tools"><button data-action="copy">copy</button></div>', "button"],
    ['<span class="tag-inline">#perf</span>', ".tag-inline"],
    ['<figure class="mermaid-block"><svg></svg></figure>', "svg"],
  ])("leaves %s to its own behaviour", (html, selector) => {
    const root = mount(`<p>${html}</p>`);
    const target = root.querySelector(selector) as Element;
    let starts = true;
    root.addEventListener("click", (e) => {
      starts = startsWriting(e);
    });

    click(target);

    expect(starts).toBe(false);
  });

  it("does not take a click with a modifier held", () => {
    const root = mount("<p>本文</p>");
    let starts = true;
    root.addEventListener("click", (e) => {
      starts = startsWriting(e);
    });

    click(root.querySelector("p") as Element, { metaKey: true });

    expect(starts).toBe(false);
  });
});

describe("tapSpot and placeCaret", () => {
  afterEach(clear);

  // The viewer and the editor draw the same blocks; the spot carries from one to the other
  it("carries the tapped block and character over to the editor", () => {
    const viewer = mount("<p>first line</p><p>second line</p>");
    const editor = mount("<p>first line</p><p>second line</p>");
    editor.contentEditable = "true";
    const second = viewer.children[1] as HTMLElement;
    const { x, y } = pointAt(second, 7);

    const spot = tapSpot(viewer, x, y, second);
    placeCaret(editor, spot);

    expect(spot).toStrictEqual({ block: 1, offset: 7 });
    const caret = globalThis.getSelection();
    expect(caret?.anchorNode?.parentElement).toBe(editor.children[1]);
    expect(caret?.anchorOffset).toBe(7);
  });

  // The editor may draw fewer blocks than the viewer did, or the tap missed every block
  it("falls back to the end of the body", () => {
    const editor = mount("<p>only</p>");
    editor.contentEditable = "true";

    placeCaret(editor, { block: 5, offset: 2 });

    const caret = globalThis.getSelection();
    expect(caret?.anchorNode?.textContent).toBe("only");
    expect(caret?.anchorOffset).toBe(4);
  });

  it("clamps an offset past the block's text to its end", () => {
    const editor = mount("<p>short</p><p>next</p>");
    editor.contentEditable = "true";

    placeCaret(editor, { block: 0, offset: 99 });

    expect(globalThis.getSelection()?.anchorOffset).toBe(5);
    expect(globalThis.getSelection()?.anchorNode?.textContent).toBe("short");
  });
});

/** The height just under an element's middle, which a drop there means "after it". */
function under(el: Element): number {
  const box = el.getBoundingClientRect();
  return box.top + box.height / 2 + 1;
}

describe("gapAt", () => {
  afterEach(clear);

  it("opens the line after the block whose middle the drop is under", () => {
    const viewer = mount("<p>first</p><p>second</p><p>third</p>");
    const second = viewer.children[1] as Element;

    const gap = gapAt(viewer, under(second));

    expect(gap?.spot).toStrictEqual({ block: 1, item: null });
    expect(gap?.y).toBeGreaterThan(second.getBoundingClientRect().bottom - 1);
  });

  it("opens the line between two items inside a list", () => {
    const viewer = mount("<p>intro</p><ul>\n<li>milk</li>\n<li>eggs</li>\n<li>tea</li>\n</ul>");
    const eggs = viewer.querySelectorAll("li")[1] as Element;

    expect(gapAt(viewer, under(eggs))?.spot).toStrictEqual({ block: 1, item: 1 });
  });

  it("has no gap above the page's first block", () => {
    const viewer = mount("<p>first</p><p>second</p>");
    const first = viewer.children[0] as Element;

    expect(gapAt(viewer, first.getBoundingClientRect().top + 1)).toBeNull();
  });
});

describe("placeCaretAfter", () => {
  afterEach(clear);

  // The editor keeps a glyph's shortcode as hidden text the viewer draws as an image: by item,
  // not by character, the caret still ends the right line
  it("ends the dropped-after item's own line, whatever its line holds", () => {
    const editor = mount(
      '<ul><li><p>a <span class="glyph-hidden">:236p:</span></p></li><li><p>eggs</p><ul><li><p>nested</p></li></ul></li><li><p>tea</p></li></ul>',
    );
    editor.contentEditable = "true";

    placeCaretAfter(editor, { block: 0, item: 1 });

    const caret = globalThis.getSelection();
    expect(caret?.anchorNode).toBe(editor.querySelectorAll("li")[1]?.querySelector("p"));
    expect(caret?.anchorOffset).toBe(1);
  });

  it("ends the body's last line without a spot", () => {
    const editor = mount("<p>first</p><ul><li><p>one</p></li><li><p>two</p></li></ul>");
    editor.contentEditable = "true";

    placeCaretAfter(editor, null);

    expect(globalThis.getSelection()?.anchorNode?.textContent).toBe("two");
  });
});
