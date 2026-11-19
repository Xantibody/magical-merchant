/**
 * Picks the diagram's caption up from `%% caption: ...`. mermaid skips `%%` lines
 * as comments, so a viewer that does not know this syntax (GitHub, other editors)
 * still draws the diagram as is, and the body needs no rewrite.
 *
 * Only the leading comment is read, so that a memo placed in the middle of the
 * diagram is not promoted to the caption.
 */
const CAPTION_COMMENT = /^%%\s*caption:\s*(?<text>.+)$/u;

export function extractCaption(source: string): string | undefined {
  const first = source.split("\n").find((line) => line.trim() !== "");
  const caption = first?.trim().match(CAPTION_COMMENT)?.groups?.text.trim();
  // A line of just `%% caption:` becomes an empty figcaption, leaving only a gap under the diagram
  return caption === "" ? undefined : caption;
}
