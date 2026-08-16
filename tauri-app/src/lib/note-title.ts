/**
 * ノートのタイトルは本文先頭の H1。frontmatter には持たない。
 *
 * 別のキーに持つと、本文の見出しと二重管理になって必ずどちらかが古くなる。
 * 他の Markdown ツールで開いたときに題が消えるのも避けたい。ここでは
 * 「先頭の H1 を切り出す/書き戻す」だけを引き受け、画面はタイトル欄と
 * エディタを別々に見せる — ファイルの中では 1 つの本文のまま。
 *
 * 一覧のタイトル(`items.ts` の firstLine)は今までどおり先頭行から導く。
 * 切り出しはあくまで表示と編集の都合で、保存形は変わらない。
 */

export interface TitledNote {
  title: string;
  /** タイトル行を除いた本文。エディタとプレビューが見るのはこちら。 */
  body: string;
}

/** ATX の H1 だけ。`#タグ` と区別するために `# ` の空白まで求める。 */
const H1 = /^#[ \t]+(?<title>.*)$/;

export function splitTitle(source: string): TitledNote {
  const [first, ...rest] = source.split("\n");
  const title = H1.exec(first ?? "")?.groups?.title.trim();
  if (title === undefined) {
    return { title: "", body: source };
  }
  // 見出しと本文の間の空行は書式であって本文ではない。ここで落とし、
  // 書き戻すときに同じ形で足す
  if (rest[0] === "") {
    rest.shift();
  }
  return { title, body: rest.join("\n") };
}

export function joinTitle(title: string, body: string): string {
  const heading = title.trim();
  if (!heading) {
    return body;
  }
  return body ? `# ${heading}\n\n${body}` : `# ${heading}\n`;
}
