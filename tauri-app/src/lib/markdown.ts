import MarkdownIt from "markdown-it";
import { getHighlighter } from "./highlighter";

const md = MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
});

export function renderMarkdownSync(source: string): string {
  return md.render(source);
}

interface ShikiBlock {
  id: string;
  code: string;
  lang: string;
}

interface RenderEnv {
  __shikiBlocks?: ShikiBlock[];
}

const fenceMd = MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
});

fenceMd.renderer.rules.fence = (tokens, idx, _options, renderEnv: RenderEnv) => {
  const token = tokens[idx];
  const lang = token.info.trim();
  const code = token.content;

  const id = `shiki-${idx}`;
  renderEnv.__shikiBlocks = renderEnv.__shikiBlocks || [];
  renderEnv.__shikiBlocks.push({ id, code, lang });

  return `<div id="${id}" class="shiki-placeholder"><pre><code>${fenceMd.utils.escapeHtml(code)}</code></pre></div>`;
};

export async function renderMarkdown(source: string): Promise<string> {
  const env: RenderEnv = {};
  let html = fenceMd.render(source, env);

  const blocks = env.__shikiBlocks || [];
  if (blocks.length > 0) {
    const highlighter = await getHighlighter();
    for (const block of blocks) {
      // 未ロード言語はプレーンテキストとして描画（フルバンドルを避けるため）
      const lang = highlighter.getLoadedLanguages().includes(block.lang) ? block.lang : "text";
      try {
        // デュアルテーマで描画し、テーマ切替にはCSS変数で即追従させる
        const highlighted = highlighter.codeToHtml(block.code, {
          lang,
          themes: {
            light: "github-light-default",
            dark: "github-dark-default",
          },
          defaultColor: false,
        });
        html = html.replace(
          `<div id="${block.id}" class="shiki-placeholder"><pre><code>${fenceMd.utils.escapeHtml(block.code)}</code></pre></div>`,
          highlighted,
        );
      } catch {
        // keep fallback
      }
    }
  }

  return html;
}
