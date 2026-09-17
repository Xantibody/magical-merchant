import { describe, it, expect } from "vitest";
import { noteRoute } from "./note-route";

// ノートを開く経路は全部ここを通る。Codex は別の面に住むので、ID だけで
// なく「どの面か」も URL に写さないと、開いた先に相手が居ない(#255)
describe("noteRoute", () => {
  it("points a note at the Note surface", () => {
    expect(noteRoute("note", "20260903_120000.md")).toBe("/notes?file=20260903_120000.md");
  });

  it("points a codex at the Codex surface", () => {
    expect(noteRoute("codex", "20260903_120000.md")).toBe("/codex?file=20260903_120000.md");
  });

  it("is just the surface when there is nothing to open", () => {
    expect(noteRoute("note")).toBe("/notes");
    expect(noteRoute("codex")).toBe("/codex");
  });

  it("escapes the filename", () => {
    expect(noteRoute("note", "a b.md")).toBe("/notes?file=a%20b.md");
  });
});
