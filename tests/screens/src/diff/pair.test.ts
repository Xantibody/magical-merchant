import { describe, expect, it } from "vitest";
import { pairScenes } from "./pair.ts";

describe("pairScenes", () => {
  it("two empty directories pair nothing", () => {
    expect(pairScenes([], [])).toStrictEqual({ both: [], added: [], removed: [], incomplete: [] });
  });

  it("a scene's PNG and tree text are one scene", () => {
    expect(pairScenes(["scrawl.png", "scrawl.txt"], ["scrawl.txt", "scrawl.png"])).toStrictEqual({
      both: ["scrawl"],
      added: [],
      removed: [],
      incomplete: [],
    });
  });

  it("scenes only after are added, only before removed, in name order", () => {
    expect(
      pairScenes(
        ["notes.png", "notes.txt", "browse.png", "browse.txt", "manifest.json"],
        ["browse.png", "browse.txt", "templates.txt", "templates.png", "search.png", "search.txt"],
      ),
    ).toStrictEqual({
      both: ["browse"],
      added: ["search", "templates"],
      removed: ["notes"],
      incomplete: [],
    });
  });

  it("names a scene missing its picture or its tree on either side instead of comparing it", () => {
    expect(
      pairScenes(
        ["codex.txt", "browse.png", "browse.txt"],
        ["codex.png", "codex.txt", "browse.png"],
      ),
    ).toStrictEqual({
      both: [],
      added: [],
      removed: [],
      incomplete: ["browse", "codex"],
    });
  });
});
