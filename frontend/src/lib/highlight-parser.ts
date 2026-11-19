import type { Parser } from "@milkdown/plugin-highlight/shiki";

/**
 * Decorator that narrows highlighting to the languages the highlighter has already loaded.
 *
 * Passing an unloaded language (mermaid and the like) to Shiki throws a ShikiError, and
 * prosemirror-highlight logs a console error and then gives up highlighting the rest of the
 * code blocks in the same pass (issue #101). It lets them through here instead of adding the
 * grammar because mermaid renders the diagram right below the block, so coloring the text is
 * worth little, and the grammar file (about 36KB) costs bundle size that Lightweight does not
 * justify.
 *
 * A fence's info string is typed by hand, so it is normalized by lowercasing and trim before the
 * match, and Shiki is given the normalized language ID.
 */
export function withKnownLanguages(parser: Parser, loadedLanguages: readonly string[]): Parser {
  const known = new Set(loadedLanguages);
  return (options) => {
    const language = options.language?.trim().toLowerCase();
    if (!language || !known.has(language)) {
      return [];
    }
    return parser({ ...options, language });
  };
}
