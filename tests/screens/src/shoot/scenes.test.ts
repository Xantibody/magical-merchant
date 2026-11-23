import { describe, expect, it } from "vitest";
import { scenes } from "./scenes.ts";

describe("scenes", () => {
  it("names each scene once, in words a file name can carry between its dots", () => {
    const names = scenes.map((scene) => scene.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((name) => !/^[a-z]+(?:-[a-z]+)*$/u.test(name))).toStrictEqual([]);
  });

  it("takes every scene at one width at least", () => {
    expect(scenes.filter((scene) => scene.widths.length === 0)).toStrictEqual([]);
  });
});
