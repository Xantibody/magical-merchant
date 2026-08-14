import type { Parser } from "@milkdown/plugin-highlight/shiki";

/**
 * ハイライトを highlighter が読み込み済みの言語だけに絞るデコレータ。
 *
 * 未読込の言語(mermaid など)を Shiki に渡すと ShikiError が投げられ、
 * prosemirror-highlight は console error を出した上で同じ走査内の後続
 * コードブロックのハイライトまで打ち切ってしまう(issue #101)。
 * 文法を足すのではなく手前で素通しにするのは、mermaid はブロック直下に
 * 描画済みの図が出るためテキスト側の色付けの価値が薄く、文法ファイル
 * (約 36KB)のバンドル増が Lightweight に見合わないから。
 *
 * fence の info 文字列は手打ちなので、照合の前に小文字化と trim で
 * 正規化し、Shiki には正規化済みの言語 ID を渡す。
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
