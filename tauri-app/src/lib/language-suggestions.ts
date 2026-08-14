export const LANGUAGE_DATALIST_ID = "code-language-suggestions";

/**
 * 言語入力の補完候補。highlighter の読込済み言語(エイリアス込み)に、
 * ハイライト対象外でも図が描ける mermaid を足して並べる。未知言語の
 * ハイライトを黙ってスキップするようにした(#101)ぶん、綴り違いの
 * 受け皿はこの補完が担う。
 */
export function buildLanguageSuggestions(loadedLanguages: readonly string[]): string[] {
  return [...new Set(["mermaid", ...loadedLanguages])].toSorted();
}

/**
 * 言語入力の表示幅。input の size 属性は「平均文字幅」ベースで、monospace
 * でも "mermaid" が「mermai」に欠けた。ch 単位なら等幅で 1 文字 = 1ch なので、
 * 文字数+丸め誤差ぶんの余白 1ch で追従させる。下限は placeholder
 * 「言語」(全角 2 文字 ≈ 4ch)が収まる幅。
 */
export function languageLabelWidth(value: string): string {
  return `${Math.max(value.length, 4) + 1}ch`;
}

/**
 * 全コードブロックの言語入力が共有する datalist を document に 1 つだけ置く。
 * nodeView はブロックごとに立つので、呼び出しは冪等にしておく。
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
