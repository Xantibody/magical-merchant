import { hardbreakSchema } from "@milkdown/kit/preset/commonmark";

/**
 * Reads a `<br>` as a line break only outside the live editor.
 *
 * The preset reads every `<br>`. A break the editor drew itself never reaches that rule (its view
 * answers first), so in the live DOM it only ever meets a `<br>` the browser made: WebKit adds
 * one when a composition starts in an empty paragraph, and the unconfirmed letter gets a line
 * under it. Pasted HTML is parsed in a detached document, so a pasted `<br>` still breaks the line.
 *
 * AIDEV-NOTE: an ignore rule, not a getAttrs that declines the preset's own. A `<br>` no rule
 * takes falls through to the parser's fallback, which leaves a space in the paragraph.
 */
export const hardbreakLiveDomSchema = hardbreakSchema.extendSchema((prev) => (ctx) => {
  const schema = prev(ctx);
  return {
    ...schema,
    parseDOM: [
      {
        tag: "br",
        ignore: true,
        getAttrs: (dom: HTMLElement) => (dom.closest(".ProseMirror") ? null : false),
      },
      ...(schema.parseDOM ?? []),
    ],
  };
});
