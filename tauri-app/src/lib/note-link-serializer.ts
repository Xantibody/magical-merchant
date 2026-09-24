import type { remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import type { SliceType } from "@milkdown/kit/ctx";
import { splitNoteLinks } from "./note-link";

// remark-stringify is not a direct dependency, so its option type is read off Milkdown's slice
type StringifyOptions =
  typeof remarkStringifyOptionsCtx extends SliceType<infer T, string> ? T : never;
type TextHandler = NonNullable<NonNullable<StringifyOptions["handlers"]>["text"]>;

/**
 * Wrap the serializer's `text` handler so a note link is written back as `[[ID]]`.
 *
 * A note link is not Markdown, so the editor holds it as plain text, and the serializer
 * escapes plain text: `[[20260920_120000]]` came out as `\[\[20260920\_120000]]`. It reads
 * back the same, but the file no longer says `[[ID`, which is what the backlink search
 * (`core/src/search.rs`) and every other Markdown tool look for. The link is written raw;
 * only the alias after `|` goes through the escaping, because that part is free text.
 */
export function noteLinkText(
  base: TextHandler = (node, _parent, state, info) => state.safe(node.value, info),
): TextHandler {
  return (node, parent, state, info) => {
    const segments = splitNoteLinks(node.value);
    if (!segments.some((segment) => segment.id !== null)) {
      return base(node, parent, state, info);
    }

    // Not through base: Milkdown's handler returns a run that ends in a space unescaped,
    // which is sound for a whole text node but not for a piece cut out of one
    const escape = (value: string, around: { before: string; after: string }): string =>
      state.safe(value, { ...info, ...around, encode: [] });

    let out = "";
    segments.forEach((segment, index) => {
      const before = out.at(-1) ?? info.before;
      const after = segments[index + 1]?.text.charAt(0) ?? info.after;
      if (segment.id === null) {
        out += escape(segment.text, { before, after });
      } else if (segment.alias === null) {
        out += segment.text;
      } else {
        out += `[[${segment.id}|${escape(segment.alias, { before: "|", after: "]" })}]]`;
      }
    });
    return out;
  };
}
