import MarkdownIt from "markdown-it";
import { getHighlighter } from "./highlighter";
import { renderDiagrams } from "./mermaid";
import { isPreservedEmptyLine } from "./preserved-empty-line";
import { tagPlugin } from "./tag-markdown";

/**
 * Milkdown が空行の保存に使う `<br />` 行を、1 行ぶんの高さを持つ空の段落に
 * 変える。html: false のままだと文字どおり `<br />` と表示されてしまう。
 * トークン列で見るのは、コードフェンスの中の同じ文字列を巻き込まないため。
 */
function preservedEmptyLinePlugin(markdownIt: MarkdownIt): void {
  markdownIt.core.ruler.push("preserved_empty_line", (state) => {
    for (const token of state.tokens) {
      if (token.type === "inline" && isPreservedEmptyLine(token.content)) {
        const space = new state.Token("text", "", 0);
        // 普通の空白だと行ボックスが立たず、段落が高さ 0 に潰れるので nbsp
        space.content = " ";
        token.children = [space];
      }
    }
  });
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
});

md.use(tagPlugin);
md.use(preservedEmptyLinePlugin);

export function renderMarkdownSync(source: string): string {
  return md.render(source);
}

interface FenceBlock {
  code: string;
  lang: string;
}

interface RenderEnv {
  __fenceBlocks?: FenceBlock[];
}

const fenceMd = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
});

fenceMd.use(tagPlugin);
fenceMd.use(preservedEmptyLinePlugin);

/**
 * フェンスの描画結果を差し込む目印。markdown-it は CommonMark どおり入力中の U+0000 を
 * U+FFFD に潰すので、本文がこの形を作ることはない。
 * リテラルに直接書くと制御文字が混ざるため、コード側で組み立てる。
 */
const NUL = String.fromCodePoint(0);
export const FENCE_SLOT = `${NUL}fence${NUL}`;

fenceMd.renderer.rules.fence = (tokens, idx, _options, renderEnv: RenderEnv) => {
  const token = tokens[idx];
  (renderEnv.__fenceBlocks ??= []).push({ code: token.content, lang: token.info.trim() });
  return FENCE_SLOT;
};

function plainBlock(code: string): string {
  return `<pre><code>${fenceMd.utils.escapeHtml(code)}</code></pre>`;
}

async function highlightBlocks(blocks: FenceBlock[]): Promise<string[]> {
  let highlighter;
  try {
    highlighter = await getHighlighter();
  } catch {
    return blocks.map((block) => plainBlock(block.code));
  }

  // getLoadedLanguages() は呼ぶたびに配列を組み直すので、ブロックごとには引かない
  const loaded = new Set(highlighter.getLoadedLanguages());
  return blocks.map((block) => {
    try {
      // デュアルテーマで描画し、テーマ切替にはCSS変数で即追従させる
      return highlighter.codeToHtml(block.code, {
        // 未ロード言語はプレーンテキストとして描画（フルバンドルを避けるため）
        lang: loaded.has(block.lang) ? block.lang : "text",
        themes: {
          light: "github-light-default",
          dark: "github-dark-default",
        },
        defaultColor: false,
      });
    } catch {
      return plainBlock(block.code);
    }
  });
}

function isDiagram(block: FenceBlock): boolean {
  return block.lang.toLowerCase() === "mermaid";
}

/**
 * フェンスを種類ごとに描く。図は mermaid、それ以外は Shiki に回し、
 * 描けなかった図はソースが読める素のコードブロックに落とす。
 */
async function renderFences(blocks: FenceBlock[]): Promise<string[]> {
  const diagrams = blocks.filter((block) => isDiagram(block));
  const code = blocks.filter((block) => !isDiagram(block));

  const [svgs, highlighted] = await Promise.all([
    renderDiagrams(diagrams.map((block) => block.code)),
    code.length > 0 ? highlightBlocks(code) : [],
  ]);

  let diagramIndex = 0;
  let codeIndex = 0;
  return blocks.map((block) => {
    if (!isDiagram(block)) {
      return highlighted[codeIndex++];
    }
    const svg = svgs[diagramIndex++];
    return svg ? `<div class="mermaid-block">${svg}</div>` : plainBlock(block.code);
  });
}

/**
 * 目印を描画結果で埋める。ブロックごとに replace すると、そのたびに文書全体を
 * 走査して作り直すうえ、置換文字列の "$&" などが置換パターンとして解かれて
 * 目印そのものが出力に混ざる。スロットは本文の出現順に積まれている。
 */
function fillSlots(html: string, rendered: string[]): string {
  const parts = html.split(FENCE_SLOT);
  return parts.map((part, index) => (index === 0 ? part : rendered[index - 1] + part)).join("");
}

export async function renderMarkdown(source: string): Promise<string> {
  const env: RenderEnv = {};
  const html = fenceMd.render(source, env);

  const blocks = env.__fenceBlocks;
  if (!blocks || blocks.length === 0) {
    return html;
  }

  return fillSlots(html, await renderFences(blocks));
}
