/**
 * ノート間リンクの保存形は `[[YYYYMMDD_HHMMSS]]`。ファイル名(不変の ID)を
 * 指すのでタイトルを変えてもリンクは切れない。表示側が毎回タイトルに
 * 解決する — 解決結果はどこにも書かない。
 *
 * `[[ID|表示文字]]` と書くと、その文字で見せる。タイトルをそのまま出すと
 * 文が繋がらない場所(「詳しくは〜を見る」)のための逃げ道で、リンクの
 * 指し先は変わらない。
 */

const LINK = /\[\[(?<id>\d{8}_\d{6})(?:\|(?<alias>[^\n[\]]*))?\]\]/gu;

export interface NoteLinkSegment {
  text: string;
  /** リンクなら指し先の ID(拡張子なしのファイル名)。地の文なら null。 */
  id: string | null;
  /** `|` の後ろに書かれた表示文字。無い(または空)なら null。 */
  alias: string | null;
}

export function splitNoteLinks(text: string): NoteLinkSegment[] {
  const segments: NoteLinkSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    if (match.index > last) {
      segments.push({ text: text.slice(last, match.index), id: null, alias: null });
    }
    segments.push({
      text: match[0],
      id: match.groups?.id ?? null,
      alias: match.groups?.alias || null,
    });
    last = match.index + match[0].length;
  }
  if (last < text.length || segments.length === 0) {
    segments.push({ text: text.slice(last), id: null, alias: null });
  }
  return segments;
}

export function noteLinkFile(id: string): string {
  return `${id}.md`;
}
