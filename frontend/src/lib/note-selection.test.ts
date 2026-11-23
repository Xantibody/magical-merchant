import { describe, it, expect } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createNoteSelection } from "./note-selection";

const A = { id: "a" };
const B = { id: "b" };

function setup() {
  return createRoot((dispose) => {
    const [items, setItems] = createSignal([A, B]);
    const [loadedId, setLoadedId] = createSignal<string | null>(null);
    return { ...createNoteSelection(items, loadedId), setItems, setLoadedId, dispose };
  });
}

describe("createNoteSelection", () => {
  it("falls back to the first row while nothing is chosen", () => {
    const s = setup();
    expect(s.selected()).toBe(A);

    s.setSelectedId("b");
    expect(s.selected()).toBe(B);
    s.dispose();
  });

  // Nobody pressed anything, yet the note being looked at moved
  it("moves with the list when the chosen note is gone from it", () => {
    const s = setup();
    s.setSelectedId("a");
    s.setItems([B]);

    expect(s.selectedKey()).toBe("b");
    s.dispose();
  });

  it("keeps the key when a refetch rebuilds the same note", () => {
    const s = setup();
    s.setItems([{ id: "a" }, B]);

    expect(s.selected()).not.toBe(A);
    expect(s.selectedKey()).toBe("a");
    s.dispose();
  });

  it("says the body is loaded only for the note being looked at", () => {
    const s = setup();
    s.setLoadedId("a");
    expect(s.loaded()).toBe(true);

    s.setSelectedId("b");
    expect(s.loaded()).toBe(false);
    s.dispose();
  });
});
