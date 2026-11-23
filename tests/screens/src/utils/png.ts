// How many pixels two PNG files differ in.

import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export function differingPixels(before: Buffer, after: Buffer): number {
  const a = PNG.sync.read(before);
  const b = PNG.sync.read(after);
  if (a.width !== b.width || a.height !== b.height) {
    return Math.max(a.width * a.height, b.width * b.height);
  }
  return pixelmatch(a.data, b.data, undefined, a.width, a.height, { threshold: 0 });
}
