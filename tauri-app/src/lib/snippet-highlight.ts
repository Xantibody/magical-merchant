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
