import { describe, it, expect } from "vitest";
import { createEffect, createRoot } from "solid-js";
import { createNoteBuffer } from "./note-buffer";

function setup() {
  return createRoot((dispose) => {
    const buffer = createNoteBuffer();
    // Every value an effect saw, so a `show` that leaked a half-replaced state would be caught
    const seen: string[] = [];
    createEffect(() => {
      seen.push(
        `${buffer.loadedId()}|${buffer.title()}|${buffer.body()}|${buffer.view()}|${buffer.epoch()}`,
      );
    });
    return { buffer, seen, dispose };
  });
}

describe("createNoteBuffer", () => {
  it("starts empty, in the editor, owned by nobody, at epoch 1", () => {
    const { buffer, dispose } = setup();

    expect(buffer.title()).toBe("");
    expect(buffer.body()).toBe("");
    expect(buffer.view()).toBe("editor");
    expect(buffer.loadedId()).toBeNull();
    expect(buffer.epoch()).toBe(1);
    dispose();
  });

  it("show replaces title, body, view and id at once and advances the epoch by exactly one", () => {
    const { buffer, seen, dispose } = setup();
    const before = buffer.epoch();

    buffer.show("20260903_130000.md", "Plan", "first line", "preview");

    expect(buffer.title()).toBe("Plan");
    expect(buffer.body()).toBe("first line");
    expect(buffer.view()).toBe("preview");
    expect(buffer.loadedId()).toBe("20260903_130000.md");
    expect(buffer.epoch()).toBe(before + 1);
    // One run for the initial state, one for the whole show: nothing in between
    expect(seen).toStrictEqual(["null|||editor|1", "20260903_130000.md|Plan|first line|preview|2"]);
    dispose();
  });

  it("advances the epoch on every show, even of the same note and body", () => {
    const { buffer, dispose } = setup();

    buffer.show("a.md", "T", "B", "editor");
    buffer.show("a.md", "T", "B", "editor");

    expect(buffer.epoch()).toBe(3);
    dispose();
  });

  it("leaves the epoch and the id alone when the body, title or view is set directly", () => {
    const { buffer, dispose } = setup();
    buffer.show("a.md", "T", "B", "editor");

    buffer.setBody("typed");
    buffer.setTitle("Renamed");
    buffer.setView("mindmap");

    expect(buffer.epoch()).toBe(2);
    expect(buffer.loadedId()).toBe("a.md");
    expect(buffer.body()).toBe("typed");
    expect(buffer.title()).toBe("Renamed");
    expect(buffer.view()).toBe("mindmap");
    dispose();
  });

  it("full joins the title back as the leading H1", () => {
    const { buffer, dispose } = setup();

    buffer.show("a.md", "Plan", "first line", "editor");
    expect(buffer.full()).toBe("# Plan\n\nfirst line");

    buffer.setBody("");
    expect(buffer.full()).toBe("# Plan\n");

    buffer.setTitle("   ");
    buffer.setBody("no heading");
    expect(buffer.full()).toBe("no heading");
    dispose();
  });

  it("unload drops only the id", () => {
    const { buffer, dispose } = setup();
    buffer.show("a.md", "Plan", "first line", "preview");

    buffer.unload();

    expect(buffer.loadedId()).toBeNull();
    expect(buffer.title()).toBe("Plan");
    expect(buffer.body()).toBe("first line");
    expect(buffer.view()).toBe("preview");
    expect(buffer.epoch()).toBe(2);
    dispose();
  });
});
