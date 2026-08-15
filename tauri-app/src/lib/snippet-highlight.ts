/**
 * 検索ヒットの抜粋を「前・一致・後」に分ける。core が返す位置は文字数
 * なので、UTF-16 の添字ではなくコードポイントで数える。
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
