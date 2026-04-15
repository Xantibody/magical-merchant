import MarkdownIt from "markdown-it";

const md = MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
});

export function renderMarkdownSync(source: string): string {
  return md.render(source);
}

export async function renderMarkdown(source: string): Promise<string> {
  const localMd = MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
  });

  const env: {
    __shikiBlocks?: { id: string; code: string; lang: string }[];
  } = {};

  const defaultFence = localMd.renderer.rules.fence;
  localMd.renderer.rules.fence = (tokens, idx, _options, renderEnv) => {
    const token = tokens[idx];
    const lang = token.info.trim();
    const code = token.content;

    const id = `shiki-${idx}`;
    renderEnv.__shikiBlocks = renderEnv.__shikiBlocks || [];
    renderEnv.__shikiBlocks.push({ id, code, lang });

    return `<div id="${id}" class="shiki-placeholder"><pre><code>${localMd.utils.escapeHtml(code)}</code></pre></div>`;
  };

  let html = localMd.render(source, env);

  localMd.renderer.rules.fence = defaultFence;

  const blocks = env.__shikiBlocks || [];
  if (blocks.length > 0) {
    const { codeToHtml } = await import("shiki");
    for (const block of blocks) {
      try {
        const highlighted = await codeToHtml(block.code, {
          lang: block.lang || "text",
          theme: "github-dark-default",
        });
        html = html.replace(
          `<div id="${block.id}" class="shiki-placeholder"><pre><code>${localMd.utils.escapeHtml(block.code)}</code></pre></div>`,
          highlighted,
        );
      } catch {
        // keep fallback
      }
    }
  }

  return html;
}
