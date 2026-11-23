// Which scenes two shoot directories share, from their file names: a scene is `<name>.png` and
// `<name>.txt`, and any other file in the directory is no scene. A scene with only one of the two
// on either side is incomplete, and is named rather than compared.

export interface Pairs {
  both: string[];
  added: string[];
  removed: string[];
  incomplete: string[];
}

interface Listing {
  whole: Set<string>;
  half: Set<string>;
}

function scenes(files: string[]): Listing {
  const pictures = new Set<string>();
  const trees = new Set<string>();
  for (const file of files) {
    const match = /^(?<scene>.+)\.(?<kind>png|txt)$/u.exec(file)?.groups;
    if (match?.["scene"] !== undefined) {
      (match["kind"] === "png" ? pictures : trees).add(match["scene"]);
    }
  }
  const named = new Set([...pictures, ...trees]);
  return {
    whole: new Set([...named].filter((scene) => pictures.has(scene) && trees.has(scene))),
    half: new Set([...named].filter((scene) => !pictures.has(scene) || !trees.has(scene))),
  };
}

export function pairScenes(before: string[], after: string[]): Pairs {
  const a = scenes(before);
  const b = scenes(after);
  const incomplete = new Set([...a.half, ...b.half]);
  const usable = (name: string): boolean => !incomplete.has(name);
  return {
    both: [...a.whole].filter((name) => b.whole.has(name)).toSorted(),
    added: [...b.whole].filter((name) => !a.whole.has(name) && usable(name)).toSorted(),
    removed: [...a.whole].filter((name) => !b.whole.has(name) && usable(name)).toSorted(),
    incomplete: [...incomplete].toSorted(),
  };
}
