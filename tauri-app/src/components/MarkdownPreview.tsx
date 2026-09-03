import { createSignal, createEffect, on, Show } from "solid-js";
import { renderMarkdown } from "../lib/markdown";
import { resolvedTheme } from "../lib/theme";
import DiagramZoom from "./DiagramZoom";
import "../styles/markdown-preview.css";
import type { ZoomedDiagram } from "./DiagramZoom";
import type { JSX } from "solid-js";

interface MarkdownPreviewProps {
  source: string;
  /** `[[ID]]` をタイトルで描くための解決表。無ければ保存形のまま出る。 */
  noteTitles?: ReadonlyMap<string, string>;
  /** `:name:` を画像で描くための登録表。無ければ保存形のまま出る。 */
  glyphs?: ReadonlyMap<string, string>;
}

export default function MarkdownPreview(props: MarkdownPreviewProps): JSX.Element {
  const [html, setHtml] = createSignal("");
  const [zoomed, setZoomed] = createSignal<ZoomedDiagram | undefined>();

  let renderVersion = 0;

  createEffect(
    on(
      // mermaid はテーマの色を SVG に焼き込むので、切り替えたら描き直すしかない
      () => [props.source, resolvedTheme(), props.noteTitles, props.glyphs] as const,
      async ([source, , noteTitles, glyphs]) => {
        const currentVersion = ++renderVersion;
        if (!source) {
          setHtml("");
          return;
        }
        const rendered = await renderMarkdown(source, noteTitles, glyphs);
        if (currentVersion === renderVersion) {
          setHtml(rendered);
        }
      },
    ),
  );

  // 図は本文と違って折り返せない。狭い画面では幅に合わせて縮めておき、
  // 押されたときだけ原寸で開く
  const openZoom = (e: MouseEvent): void => {
    const target = e.target instanceof Element ? e.target : null;
    const svg = target?.closest(".mermaid-block")?.querySelector("svg");
    if (svg) {
      setZoomed({ svg: svg.outerHTML, width: svg.style.maxWidth });
    }
  };

  return (
    <>
      <div class="markdown-preview" innerHTML={html()} onClick={openZoom} role="presentation" />

      <Show when={zoomed()}>
        {(diagram) => <DiagramZoom diagram={diagram()} onClose={() => setZoomed(undefined)} />}
      </Show>
    </>
  );
}
