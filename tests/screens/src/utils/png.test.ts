import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { differingPixels } from "./png.ts";

function png(
  width: number,
  height: number,
  odd?: { x: number; y: number; rgba: number[] },
): Buffer {
  const image = new PNG({ width, height });
  image.data.fill(255);
  if (odd !== undefined) {
    image.data.set(odd.rgba, (odd.y * width + odd.x) * 4);
  }
  return PNG.sync.write(image);
}

describe("differingPixels", () => {
  it("the same image differs in no pixel", () => {
    expect(differingPixels(png(4, 4), png(4, 4))).toBe(0);
  });

  it("a pixel one step off counts", () => {
    expect(differingPixels(png(4, 4), png(4, 4, { x: 2, y: 1, rgba: [255, 255, 254, 255] }))).toBe(
      1,
    );
  });

  it("images of different sizes differ in every pixel of the larger", () => {
    expect(differingPixels(png(4, 4), png(4, 6))).toBe(24);
  });
});
