/**
 * ```` ```diff ```` フェンスを行ごとに描く。Shiki は diff を持っておらず、
 * 渡してもプレーンテキストに落ちる(highlighter.ts の 8 言語に無い)。
 * 差分で読みたいのは「どの行が増えて減ったか」だけなので、行の中を
 * 構文で塗るより、行そのものに色を敷くほうが目的に合う。
 *
 * 出力は他のコードブロックと同じ `<pre><code>` の枠に収める。枠が違うと
 * 背景・余白・字送りがずれ、同じノートの中で diff だけ別物に見える。
 */

/** markdown-it の escapeHtml と同じ 4 文字。この関数は markdown-it に依存しない */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * 先頭の +/- だけを span で括る。色は親の diff-add / diff-del が与える。
 * 背景だけに頼らず記号にも色を置くと、背景の差が読めない環境でも区別が付く
 */
function signed(line: string): string {
  return `<span class="diff-sign">${line.slice(0, 1)}</span>${escapeHtml(line.slice(1))}`;
}

function renderLine(line: string): string {
  // +++ / --- は差分本体ではなくファイル名のヘッダ。追加・削除として
  // 塗ると、どこから差分が始まるのか読めなくなる
  if (line.startsWith("+++") || line.startsWith("---")) {
    return `<div class="diff-line">${escapeHtml(line)}</div>`;
  }
  if (line.startsWith("@@")) {
    return `<div class="diff-line diff-hunk">${escapeHtml(line)}</div>`;
  }
  if (line.startsWith("+")) {
    return `<div class="diff-line diff-add">${signed(line)}</div>`;
  }
  if (line.startsWith("-")) {
    return `<div class="diff-line diff-del">${signed(line)}</div>`;
  }
  // 空行を空の div にすると行ボックスが立たず高さが 0 になる。
  // white-space: pre の下では空白 1 つで 1 行ぶんの高さが戻る
  return `<div class="diff-line">${line === "" ? " " : escapeHtml(line)}</div>`;
}

export function renderDiffBlock(code: string): string {
  // フェンスの中身は必ず改行で終わる。そのまま split すると最後に
  // 空の行が 1 本増える
  const lines = code.replace(/\n$/u, "").split("\n");
  // 行の間に改行を入れない。pre の中では改行がそのまま 1 行として描かれる
  return `<pre><code>${lines.map((line) => renderLine(line)).join("")}</code></pre>`;
}
