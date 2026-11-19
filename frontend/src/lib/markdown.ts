import MarkdownIt from "markdown-it";
import type { Env, MarkdownIt as MarkdownItInstance } from "markdown-it";
import copyIcon from "@phosphor-icons/core/assets/regular/copy.svg?raw";
import cornersOutIcon from "@phosphor-icons/core/assets/regular/corners-out.svg?raw";
import { extractCaption } from "./diagram-caption";
import { renderDiffBlock } from "./diff-block";
import { glyphPlugin } from "./glyph-markdown";
import { t } from "./i18n";
import { lineMarksPlugin } from "./line-marks-markdown";
import type { LineMarksEnv } from "./line-marks-markdown";
import type { LineMark } from "./diff-marks";
import { renderDiagrams } from "./mermaid";
import { noteLinkPlugin } from "./note-link-markdown";
import { isPreservedEmptyLine } from "./preserved-empty-line";
import { tagPlugin } from "./tag-markdown";
import { taskListPlugin } from "./task-list-markdown";

/**
 * Turn the `<br />` line Milkdown uses to store an empty line into an empty paragraph one
 * line high. Left at html: false it would literally display `<br />`.
 * It is looked at on the token stream so the same string inside a code fence is not caught.
 */
function preservedEmptyLinePlugin(markdownIt: MarkdownItInstance): void {
  markdownIt.core.ruler.push("preserved_empty_line", (state) => {
    for (const token of state.tokens) {
      if (token.type === "inline" && isPreservedEmptyLine(token.content)) {
        const space = new state.Token("text", "", 0);
        // An ordinary space raises no line box and collapses the paragraph to height 0, hence nbsp
        space.content = " ";
        token.children = [space];
      }
    }
  });
}

/**
 * `md` and `fenceMd` are two instances of the same configuration. They are apart only
 * because the fence renderer rule differs: the split keeps the sync version
 * (`renderMarkdownSync`) from emitting the slot markers, and the configuration itself is
 * always kept in step.
 */
function createRenderer(): MarkdownItInstance {
  const renderer = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
  });
  renderer.use(taskListPlugin);
  renderer.use(tagPlugin);
  renderer.use(preservedEmptyLinePlugin);
  renderer.use(noteLinkPlugin);
  renderer.use(glyphPlugin);
  renderer.use(lineMarksPlugin);
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
  /** The margin mark while the history is open. A fence is drawn elsewhere, so it is held here. */
  mark?: LineMark;
}

interface RenderEnv extends Env, LineMarksEnv {
  fenceBlocks?: FenceBlock[];
  noteTitles?: ReadonlyMap<string, string>;
  /** `:name:` to a data URL. Without one, the stored form is printed as it is. */
  glyphs?: ReadonlyMap<string, string>;
}

const fenceMd = createRenderer();

/**
 * The marker where a fence's render result is spliced in. markdown-it crushes a U+0000 in
 * the input to U+FFFD as CommonMark says, so the body can never form this shape.
 * Written straight into a literal it would embed a control character, so it is built in code.
 */
const NUL = String.fromCodePoint(0);
export const FENCE_SLOT = `${NUL}fence${NUL}`;

function plainBlock(code: string): string {
  return `<pre><code>${fenceMd.utils.escapeHtml(code)}</code></pre>`;
}

/**
 * Put the margin mark on the block's opening tag. For a paragraph the plugin attaches it to
 * the token, but a fence's render result is a string that comes from Shiki or mermaid, so
 * the class is added here. The sign's span goes at the head inside the block, and CSS
 * pulls it out into the margin.
 */
function withMark(html: string, mark: LineMark | undefined): string {
  if (!mark) {
    return html;
  }
  const open = html.indexOf(">");
  if (open === -1) {
    return html;
  }
  const cls = `diff-mark diff-mark--${mark}`;
  const tag = html.slice(0, open);
  const opened = tag.includes(' class="')
    ? tag.replace(' class="', ` class="${cls} `)
    : `${tag} class="${cls}"`;
  const sign = `<span class="diff-sign" aria-hidden="true">${mark === "add" ? "+" : "−"}</span>`;
  return `${opened}>${sign}${html.slice(open + 1)}`;
}

/**
 * The actions that appear on hover. The render result is fed to innerHTML, so no SolidJS
 * part can sit there; as in the node view (code-block-view-plugin.ts) a raw SVG string is
 * embedded. What happens on a press is taken by MarkdownPreview through data-action.
 */
function toolButton(action: string, label: string, content: string): string {
  const escaped = fenceMd.utils.escapeHtml(label);
  return (
    `<button type="button" class="preview-tool" data-action="${action}" ` +
    `title="${escaped}" aria-label="${escaped}">${content}</button>`
  );
}

/**
 * Attach the copy tool and the raw source to a code block. The source is held in the DOM so
 * the pressed block's contents need not be worked back out of the render result: a diff's
 * lines are divs with no newlines, so textContent does not restore them.
 * The tools go inside the pre (the same structure as the node view). Wrapped outside, the
 * element directly under a block would differ between the preview and the editor, and the
 * assumption that their geometry lines up would break.
 */
function codeBlock(pre: string, block: FenceBlock): string {
  const openEnd = pre.indexOf(">");
  const end = pre.lastIndexOf("</pre>");
  if (!pre.startsWith("<pre") || openEnd === -1 || end === -1) {
    return pre;
  }
  const lang = block.lang
    ? `<span class="preview-tools-lang">${fenceMd.utils.escapeHtml(block.lang)}</span>`
    : "";
  const tools = `<div class="preview-tools">${lang}${toolButton("copy", t().editor.copyCode, copyIcon)}</div>`;
  // Keep the class Shiki attached at the head. Added after it, `<pre class="shiki` still counts
  const source = fenceMd.utils.escapeHtml(block.code);
  return withMark(
    `${pre.slice(0, openEnd)} data-source="${source}"${pre.slice(openEnd, end)}${tools}${pre.slice(end)}`,
    block.mark,
  );
}

function diagramTools(): string {
  const { preview } = t();
  return (
    `<div class="preview-tools">${toolButton("zoom", preview.zoom, cornersOutIcon)}` +
    `${toolButton("svg", preview.saveSvg, "SVG")}${toolButton("png", preview.savePng, "PNG")}</div>`
  );
}

fenceMd.renderer.rules.fence = (tokens, idx, _options, renderEnv) => {
  const token = tokens[idx];
  // `render()` always passes env, but the type says it may be omitted.
  // With nowhere to splice into, fall back to a plain <pre> rather than drop the body
  const env = renderEnv as RenderEnv | undefined;
  if (!env) {
    return plainBlock(token.content);
  }
  const meta = token.meta as { mark?: LineMark } | null;
  (env.fenceBlocks ??= []).push({
    code: token.content,
    lang: token.info.trim(),
    mark: meta?.mark,
  });
  return FENCE_SLOT;
};

async function highlightBlocks(blocks: FenceBlock[]): Promise<string[]> {
  let highlighter;
  try {
    // Dynamic import: shiki (the core plus the regex engine) is not read until a note that
    // holds a code fence is opened. Written statically it ships in the Workspace chunk
    const { getHighlighter } = await import("./highlighter");
    highlighter = await getHighlighter();
  } catch {
    return blocks.map((block) => plainBlock(block.code));
  }

  // getLoadedLanguages() rebuilds the array on every call, so it is not read per block
  const loaded = new Set(highlighter.getLoadedLanguages());
  return blocks.map((block) => {
    try {
      // Render with dual themes and follow a theme switch at once through CSS variables
      return highlighter.codeToHtml(block.code, {
        // An unloaded language is rendered as plain text (to avoid the full bundle)
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
 * A diagram is wrapped in `<figure>`, and a `<figcaption>` is added when it has a caption.
 * The editor's node view emits the same figcaption: if only one of them grew taller, the
 * assumption that the cursor lands on the character at the pressed coordinate would break
 * and the body below the diagram would shift (#168).
 */
function diagramBlock(svg: string, block: FenceBlock): string {
  const caption = extractCaption(block.code);
  const figcaption = caption
    ? `<figcaption class="mermaid-caption">${fenceMd.utils.escapeHtml(caption)}</figcaption>`
    : "";
  return withMark(
    `<figure class="mermaid-block"><div class="mermaid-figure">${svg}</div>` +
      `${figcaption}${diagramTools()}</figure>`,
    block.mark,
  );
}

type FenceKind = "diagram" | "diff" | "code";

function kindOf(block: FenceBlock): FenceKind {
  const lang = block.lang.toLowerCase();
  if (lang === "mermaid") {
    return "diagram";
  }
  // diff is not among Shiki's loaded languages. Sending it there only yields plain text,
  // and the +/- lines are exactly what is worth reading
  return lang === "diff" ? "diff" : "code";
}

/**
 * Draw the fences by kind. Diagrams go to mermaid, diff to its own renderer and the rest to
 * Shiki; a diagram that could not be drawn falls back to a plain code block whose source
 * can be read.
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
        return codeBlock(renderDiffBlock(block.code), block);
      }
      case "code": {
        return codeBlock(highlighted[codeIndex++], block);
      }
      default: {
        const svg = svgs[diagramIndex++];
        // A diagram that could not be drawn shows its source. If it can be read it may as well be copied
        return svg ? diagramBlock(svg, block) : codeBlock(plainBlock(block.code), block);
      }
    }
  });
}

/**
 * Fill the markers with the render results. A replace per block would rescan and rebuild
 * the whole document each time, and "$&" and the like in the replacement string would be
 * read as a replacement pattern, mixing the marker itself into the output. The slots are
 * stacked in the order they appear in the body.
 */
function fillSlots(html: string, rendered: string[]): string {
  const parts = html.split(FENCE_SLOT);
  return parts.map((part, index) => (index === 0 ? part : rendered[index - 1] + part)).join("");
}

export async function renderMarkdown(
  source: string,
  noteTitles?: ReadonlyMap<string, string>,
  glyphs?: ReadonlyMap<string, string>,
  marks?: readonly (LineMark | undefined)[],
): Promise<string> {
  const env: RenderEnv = { noteTitles, glyphs, marks };
  const html = fenceMd.render(source, env);

  const blocks = env.fenceBlocks;
  if (!blocks || blocks.length === 0) {
    return html;
  }

  return fillSlots(html, await renderFences(blocks));
}
