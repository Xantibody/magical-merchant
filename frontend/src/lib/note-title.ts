/**
 * A note's title is the H1 at the top of the body. It is not held in frontmatter.
 *
 * Holding it in a separate key would duplicate the body's heading, and one of the two would always
 * go stale. Losing the title when the file is opened in another Markdown tool is also to be
 * avoided. This module only takes on cutting the leading H1 out and writing it back; the screen
 * shows the title field and the editor separately. Inside the file it stays one body.
 *
 * The list's title (`firstLine` in `items.ts`) is still derived from the first line. The split is
 * only for display and editing; the stored form does not change.
 */

export interface TitledNote {
  title: string;
  /** The body without the title line. This is what the editor and the preview see. */
  body: string;
}

/** ATX H1 only. Requires the space in `# ` so that a `#tag` is not taken for a heading. */
const H1 = /^#[ \t]+(?<title>.*)$/u;

export function splitTitle(source: string): TitledNote {
  const [first, ...rest] = source.split("\n");
  const title = H1.exec(first ?? "")?.groups?.title.trim();
  if (title === undefined) {
    return { title: "", body: source };
  }
  // The blank line between the heading and the body is formatting, not body. Drop it here and
  // add it back in the same shape when writing out
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
