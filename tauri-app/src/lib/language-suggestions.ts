export const LANGUAGE_DATALIST_ID = "code-language-suggestions";

/**
 * Completion candidates for the language input. Takes the languages the highlighter has
 * loaded (aliases included) and adds mermaid, which draws a diagram even though it is
 * not highlighted. Since highlighting an unknown language is now skipped silently
 * (#101), this completion is what catches a misspelling.
 */
export function buildLanguageSuggestions(loadedLanguages: readonly string[]): string[] {
  return [...new Set(["mermaid", ...loadedLanguages])].toSorted();
}

/**
 * Put exactly one datalist in the document, shared by every code block's language input.
 * A nodeView stands up per block, so the call is kept idempotent.
 */
export function ensureLanguageDatalist(doc: Document, languages: readonly string[]): string {
  let list = doc.querySelector(`#${LANGUAGE_DATALIST_ID}`);
  if (!list) {
    list = doc.createElement("datalist");
    list.id = LANGUAGE_DATALIST_ID;
    doc.body.append(list);
  }
  list.replaceChildren(
    ...languages.map((language) => {
      const option = doc.createElement("option");
      option.value = language;
      return option;
    }),
  );
  return LANGUAGE_DATALIST_ID;
}
