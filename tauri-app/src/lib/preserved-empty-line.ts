/**
 * Milkdown は空の段落(見た目の空行)を `<br />` という HTML 行として
 * Markdown に保存し、読み戻すときに空行へ復元する(remark-preserve-empty-line)。
 * エディタの外 — プレビューや一覧のタイトル — がこの行を文字どおり
 * `<br />` と見せないよう、判定を一箇所に寄せる。
 *
 * 揺れ(`<br>` `<br/>` `<br >`)も Milkdown の認識と同じく空行として扱う。
 */
export function isPreservedEmptyLine(line: string): boolean {
  return /^<br[ \t]*\/?[ \t]*>$/i.test(line.trim());
}
