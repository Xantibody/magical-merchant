/**
 * 図の説明を `%% caption: …` から拾う。mermaid は `%%` の行をコメントとして
 * 読み飛ばすので、この記法を知らないビューア(GitHub や他のエディタ)でも
 * 図はそのまま描け、本文を書き換えずに済む。
 *
 * 先頭のコメントだけを見るのは、図の途中に置いたメモを説明文として
 * 引き上げないため。
 */
const CAPTION_COMMENT = /^%%\s*caption:\s*(?<text>.+)$/u;

export function extractCaption(source: string): string | undefined {
  const first = source.split("\n").find((line) => line.trim() !== "");
  const caption = first?.trim().match(CAPTION_COMMENT)?.groups?.text.trim();
  // `%% caption:` だけの行は空の figcaption になり、図の下に余白だけが残る
  return caption === "" ? undefined : caption;
}
