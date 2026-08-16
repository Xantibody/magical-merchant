/**
 * ノート間リンクの保存形は `[[YYYYMMDD_HHMMSS]]`。ファイル名(不変の ID)を
 * 指すのでタイトルを変えてもリンクは切れない。表示側が毎回タイトルに
 * 解決する — 解決結果はどこにも書かない。
 */

const LINK = /\[\[(\d{8}_\d{6})\]\]/g;

export interface NoteLinkSegment {
  text: string;
  /** リンクなら指し先の ID(拡張子なしのファイル名)。地の文なら null。 */
  id: string | null;
}

export function splitNoteLinks(text: string): NoteLinkSegment[] {
  const segments: NoteLinkSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    if (match.index > last) {
      segments.push({ text: text.slice(last, match.index), id: null });
    }
    segments.push({ text: match[0], id: match[1] });
    last = match.index + match[0].length;
  }
  if (last < text.length || segments.length === 0) {
    segments.push({ text: text.slice(last), id: null });
  }
  return segments;
}

export function noteLinkFile(id: string): string {
  return `${id}.md`;
}
