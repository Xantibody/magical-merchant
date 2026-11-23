// diff <before> <after>: names every scene whose picture or tree text changed, and every scene
// only one side has. Exits 0 when nothing differs, 1 when it named a difference, and 2 when it
// could not compare: a usage mistake, an unreadable directory or file, or a scene missing its
// picture or its tree.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { differingPixels } from "../utils/png.ts";
import { pairScenes } from "./pair.ts";

const { positionals } = parseArgs({ allowPositionals: true });
const [beforeArg, afterArg] = positionals;
if (beforeArg === undefined || afterArg === undefined) {
  console.error("usage: diff <before> <after>");
  process.exit(2);
}
// Named again so the functions below see them as set, not as the possibly missing arguments
const before: string = beforeArg;
const after: string = afterArg;

async function changes(scene: string): Promise<string[]> {
  const [pngBefore, pngAfter, treeBefore, treeAfter] = await Promise.all([
    readFile(join(before, `${scene}.png`)),
    readFile(join(after, `${scene}.png`)),
    readFile(join(before, `${scene}.txt`), "utf8"),
    readFile(join(after, `${scene}.txt`), "utf8"),
  ]);
  const pixels = differingPixels(pngBefore, pngAfter);
  return [...(pixels > 0 ? [`${pixels} px`] : []), ...(treeBefore === treeAfter ? [] : ["tree"])];
}

try {
  const pairs = pairScenes(await readdir(before), await readdir(after));
  const compared = await Promise.all(
    pairs.both.map(async (scene) => ({ scene, what: await changes(scene) })),
  );
  const lines = [
    ...compared
      .filter(({ what }) => what.length > 0)
      .map(({ scene, what }) => `changed ${scene} (${what.join(", ")})`),
    ...pairs.added.map((scene) => `added ${scene}`),
    ...pairs.removed.map((scene) => `removed ${scene}`),
  ];
  for (const line of lines) {
    console.log(line);
  }
  console.error(`${pairs.both.length} scenes compared, ${lines.length} differ`);
  if (pairs.incomplete.length > 0) {
    console.error(`missing a picture or a tree, so not compared: ${pairs.incomplete.join(", ")}`);
    process.exitCode = 2;
  } else {
    process.exitCode = lines.length > 0 ? 1 : 0;
  }
} catch (error) {
  console.error(`could not compare ${before} with ${after}: ${String(error)}`);
  process.exitCode = 2;
}
