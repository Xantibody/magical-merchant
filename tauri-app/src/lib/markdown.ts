import MarkdownIt from "markdown-it";
import { codeToHtml } from "shiki";

const md = MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
});

const defaultFence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, idx, _options, env, _self) => {
  const token = tokens[idx];
  const lang = token.info.trim();
  const code = token.content;

  // Shiki rendering is async, so we insert a placeholder and replace later
  const id = `shiki-${idx}`;
  env.__shikiBlocks = env.__shikiBlocks || [];
  env.__shikiBlocks.push({ id, code, lang });

  return `<div id="${id}" class="shiki-placeholder"><pre><code>${md.utils.escapeHtml(code)}</code></pre></div>`;
};

export async function renderMarkdown(source: string): Promise<string> {
  const env: { __shikiBlocks?: { id: string; code: string; lang: string }[] } = {};
  let html = md.render(source, env);

  const blocks = env.__shikiBlocks || [];
  for (const block of blocks) {
    try {
      const highlighted = await codeToHtml(block.code, {
        lang: block.lang || "text",
        theme: "github-light",
      });
      html = html.replace(
        `<div id="${block.id}" class="shiki-placeholder"><pre><code>${md.utils.escapeHtml(block.code)}</code></pre></div>`,
        highlighted,
      );
    } catch {
      // If shiki doesn't support the lang, keep the fallback
    }
  }

  return html;
}

export function renderMarkdownSync(source: string): string {
  return md.render(source);
}

// Restore default fence for sync rendering
void defaultFence;
