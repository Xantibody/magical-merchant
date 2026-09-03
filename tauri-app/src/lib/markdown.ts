import MarkdownIt from "markdown-it";
import type { Env, MarkdownIt as MarkdownItInstance } from "markdown-it";
import { extractCaption } from "./diagram-caption";
import { renderDiffBlock } from "./diff-block";
import { glyphPlugin } from "./glyph-markdown";
import { renderDiagrams } from "./mermaid";
import { noteLinkPlugin } from "./note-link-markdown";
import { isPreservedEmptyLine } from "./preserved-empty-line";
import { tagPlugin } from "./tag-markdown";

/**
 * Milkdown が空行の保存に使う `<br />` 行を、1 行ぶんの高さを持つ空の段落に
 * 変える。html: false のままだと文字どおり `<br />` と表示されてしまう。
 * トークン列で見るのは、コードフェンスの中の同じ文字列を巻き込まないため。
 */
function preservedEmptyLinePlugin(markdownIt: MarkdownItInstance): void {
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

/**
 * `md` と `fenceMd` は同じ構成の 2 インスタンス。分かれているのは fence の
 * renderer rule だけが違うため — 同期版 (`renderMarkdownSync`) にスロット差し
 * 込みの目印を出させないための分離で、構成そのものは常に揃える。
 */
function createRenderer(): MarkdownItInstance {
  const renderer = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
  });
  renderer.use(tagPlugin);
  renderer.use(preservedEmptyLinePlugin);
  renderer.use(noteLinkPlugin);
  renderer.use(glyphPlugin);
  return renderer;
}

const md = createRenderer();

export function renderMarkdownSync(
  source: string,
  noteTitles?: ReadonlyMap<string, string>,
  glyphs?: ReadonlyMap<string, string>,
): string {
  const env: RenderEnv = { noteTitles, glyphs };
  return md.render(source, env);
}

interface FenceBlock {
  code: string;
  lang: string;
}

interface RenderEnv extends Env {
  fenceBlocks?: FenceBlock[];
  noteTitles?: ReadonlyMap<string, string>;
  /** `:name:` → データ URL。無ければ保存形のまま出る。 */
  glyphs?: ReadonlyMap<string, string>;
}

const fenceMd = createRenderer();

/**
 * フェンスの描画結果を差し込む目印。markdown-it は CommonMark どおり入力中の U+0000 を
 * U+FFFD に潰すので、本文がこの形を作ることはない。
 * リテラルに直接書くと制御文字が混ざるため、コード側で組み立てる。
 */
const NUL = String.fromCodePoint(0);
export const FENCE_SLOT = `${NUL}fence${NUL}`;

function plainBlock(code: string): string {
  return `<pre><code>${fenceMd.utils.escapeHtml(code)}</code></pre>`;
}

fenceMd.renderer.rules.fence = (tokens, idx, _options, renderEnv) => {
  const token = tokens[idx];
  // `render()` は env を必ず渡すが、型の上では省略できることになっている。
  // 差し込み先が無ければ本文を落とすより素の <pre> に倒す
  const env = renderEnv as RenderEnv | undefined;
  if (!env) {
    return plainBlock(token.content);
  }
  (env.fenceBlocks ??= []).push({ code: token.content, lang: token.info.trim() });
  return FENCE_SLOT;
};

async function highlightBlocks(blocks: FenceBlock[]): Promise<string[]> {
  let highlighter;
  try {
    // 動的 import: shiki (コア + 正規表現エンジン) はコードフェンスを含む
    // ノートを開くまで読まない。静的に書くと Workspace チャンクに同梱される
    const { getHighlighter } = await import("./highlighter");
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

/**
 * 図は `<figure>` で包み、説明があれば `<figcaption>` を足す。同じ figcaption を
 * エディタの node view も出す — 片方だけ背が高くなると、押した座標の文字に
 * カーソルを置く前提が崩れて図の下の本文がずれる (#168)。
 */
function diagramBlock(svg: string, source: string): string {
  const caption = extractCaption(source);
  const figcaption = caption
    ? `<figcaption class="mermaid-caption">${fenceMd.utils.escapeHtml(caption)}</figcaption>`
    : "";
  return `<figure class="mermaid-block"><div class="mermaid-figure">${svg}</div>${figcaption}</figure>`;
}

type FenceKind = "diagram" | "diff" | "code";

function kindOf(block: FenceBlock): FenceKind {
  const lang = block.lang.toLowerCase();
  if (lang === "mermaid") {
    return "diagram";
  }
  // diff は Shiki の読込済み言語に無い。回してもプレーンテキストになるだけで、
  // +/- の行こそが読みたいもの
  return lang === "diff" ? "diff" : "code";
}

/**
 * フェンスを種類ごとに描く。図は mermaid、diff は専用のレンダラ、残りは
 * Shiki に回し、描けなかった図はソースが読める素のコードブロックに落とす。
 */
async function renderFences(blocks: FenceBlock[]): Promise<string[]> {
  const kinds = blocks.map((block) => kindOf(block));
  const diagrams = blocks.filter((_, index) => kinds[index] === "diagram");
  const code = blocks.filter((_, index) => kinds[index] === "code");

  const [svgs, highlighted] = await Promise.all([
    renderDiagrams(diagrams.map((block) => block.code)),
    code.length > 0 ? highlightBlocks(code) : [],
  ]);

  let diagramIndex = 0;
  let codeIndex = 0;
  return blocks.map((block, index) => {
    switch (kinds[index]) {
      case "diff": {
        return renderDiffBlock(block.code);
      }
      case "code": {
        return highlighted[codeIndex++];
      }
      default: {
        const svg = svgs[diagramIndex++];
        return svg ? diagramBlock(svg, block.code) : plainBlock(block.code);
      }
    }
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

export async function renderMarkdown(
  source: string,
  noteTitles?: ReadonlyMap<string, string>,
  glyphs?: ReadonlyMap<string, string>,
): Promise<string> {
  const env: RenderEnv = { noteTitles, glyphs };
  const html = fenceMd.render(source, env);

  const blocks = env.fenceBlocks;
  if (!blocks || blocks.length === 0) {
    return html;
  }

  return fillSlots(html, await renderFences(blocks));
}
