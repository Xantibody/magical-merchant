/**
 * The stored form of a note-to-note link is `[[YYYYMMDD_HHMMSS]]`. It points at the filename (the
 * immutable ID), so changing the title never breaks the link. The display side resolves it to a
 * title every time; the resolved result is never written anywhere.
 *
 * Writing `[[ID|alias]]` shows that text instead. It is an escape hatch for places where the title
 * as it stands does not join into the sentence ("see X for details"), and it does not change what
 * the link points at.
 */

const LINK = /\[\[(?<id>\d{8}_\d{6})(?:\|(?<alias>[^\n[\]]*))?\]\]/gu;

export interface NoteLinkSegment {
  text: string;
  /** For a link, the target ID (the filename without its extension). null for plain text. */
  id: string | null;
  /** The display text written after `|`. null when it is absent or empty. */
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
