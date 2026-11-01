/**
 * Split a search hit's snippet into before, match and after. The position core returns is
 * a count of characters, so it is counted in code points, not UTF-16 indices.
 */

export interface SnippetParts {
  before: string;
  match: string;
  after: string;
}

export function splitSnippet(
  snippet: string,
  start?: number | null,
  len?: number | null,
): SnippetParts | null {
  if (start === null || start === undefined || len === null || len === undefined) {
    return null;
  }
  const chars = [...snippet];
  if (start + len > chars.length) {
    return null;
  }
  return {
    before: chars.slice(0, start).join(""),
    match: chars.slice(start, start + len).join(""),
    after: chars.slice(start + len).join(""),
  };
}

/**
 * Split the matched word inside the title into "before, match, after".
 *
 * The `match_start` core returns is a position inside the excerpt and cannot be
 * used on the title (the first line of the body). The title should be underlined
 * too, so the search happens here. Matching ignores case like core does, but the
 * returned spelling is the one that was written.
 */
export function matchInLabel(label: string, word: string): SnippetParts | null {
  if (!word) {
    return null;
  }
  const chars = [...label];
  const hay = chars.map((char) => char.toLowerCase());
  const want = [...word].map((char) => char.toLowerCase());
  // A spelling where one character lowercases to two (ǅ to dž) shifts the
  // positions. Better no underline than one drawn one character off
  if ([...hay, ...want].some((char) => [...char].length !== 1)) {
    return null;
  }
  for (let at = 0; at + want.length <= hay.length; at += 1) {
    if (want.every((char, i) => hay[at + i] === char)) {
      return {
        before: chars.slice(0, at).join(""),
        match: chars.slice(at, at + want.length).join(""),
        after: chars.slice(at + want.length).join(""),
      };
    }
  }
  return null;
}
