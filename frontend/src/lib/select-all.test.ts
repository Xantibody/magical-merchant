import { afterEach, describe, expect, it } from "vitest";
import { claimsSelectAll, isSelectAll, selectContents } from "./select-all";

const key = (init: KeyboardEventInit, target?: EventTarget): KeyboardEvent => {
  const event = new KeyboardEvent("keydown", { key: "a", cancelable: true, ...init });
  if (target) {
    Object.defineProperty(event, "target", { value: target });
  }
  return event;
};

const clearPage = (): void => {
  document.body.replaceChildren();
  getSelection()?.removeAllRanges();
};

describe("isSelectAll", () => {
  // The modifier is ⌘ on a Mac and Ctrl elsewhere; an external keyboard on Android sends either
  it("takes ⌘A and Ctrl+A, upper or lower case", () => {
    expect(isSelectAll(key({ metaKey: true }))).toBe(true);
    expect(isSelectAll(key({ ctrlKey: true }))).toBe(true);
    expect(isSelectAll(key({ metaKey: true, key: "A" }))).toBe(true);
  });

  // ⌥ and ⇧ combinations belong to the OS and the IME
  it("leaves a plain a and the other combinations alone", () => {
    expect(isSelectAll(key({}))).toBe(false);
    expect(isSelectAll(key({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isSelectAll(key({ metaKey: true, altKey: true }))).toBe(false);
  });
});

describe("claimsSelectAll", () => {
  afterEach(clearPage);

  // A field selects its own text, and that is what the person pressing it wants
  it("does not take the key from a field or an editable body", () => {
    const input = document.createElement("input");
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    document.body.append(input, editable);

    expect(claimsSelectAll(key({ metaKey: true }, input))).toBe(false);
    expect(claimsSelectAll(key({ metaKey: true }, editable))).toBe(false);
  });

  it("does not take the key from a dialog", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const button = document.createElement("button");
    dialog.append(button);
    document.body.append(dialog);

    expect(claimsSelectAll(key({ metaKey: true }, button))).toBe(false);
  });

  it("takes the key when the focus is on the page", () => {
    expect(claimsSelectAll(key({ metaKey: true }, document.body))).toBe(true);
  });
});

describe("selectContents", () => {
  afterEach(clearPage);

  it("selects what is inside the node and nothing outside", () => {
    const before = document.createElement("p");
    before.textContent = "outside";
    const body = document.createElement("div");
    body.textContent = "Body";
    document.body.append(before, body);

    selectContents(body);

    expect(String(getSelection())).toBe("Body");
  });
});
