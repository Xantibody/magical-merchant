import { createSignal, createEffect, on, onCleanup, onMount, Show } from "solid-js";
import { t } from "../lib/i18n";
import { renderMarkdown } from "../lib/markdown";
import { resolvedTheme } from "../lib/theme";
import Icon from "./Icon";
import type { JSX } from "solid-js";

interface MarkdownPreviewProps {
  source: string;
  /** `[[ID]]` をタイトルで描くための解決表。無ければ保存形のまま出る。 */
  noteTitles?: ReadonlyMap<string, string>;
}

interface ZoomedDiagram {
  svg: string;
  /** 図の原寸。mermaid が SVG の max-width に書き込んだ値をそのまま使う */
  width: string;
}

function DiagramZoom(props: { diagram: ZoomedDiagram; onClose: () => void }): JSX.Element {
  let ref: HTMLDivElement | undefined;

  onMount(() => {
    // 画面より広い図は、端ではなく真ん中から見せる
    if (ref) {
      ref.scrollLeft = (ref.scrollWidth - ref.clientWidth) / 2;
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        props.onClose();
      }
    };
    globalThis.addEventListener("keydown", onKeyDown);
    onCleanup(() => globalThis.removeEventListener("keydown", onKeyDown));
  });

  return (
    <div ref={ref} class="mermaid-zoom" onClick={() => props.onClose()} role="presentation">
      <div
        class="mermaid-zoom-canvas"
        style={{ width: props.diagram.width }}
        innerHTML={props.diagram.svg}
      />
      <button
        type="button"
        class="icon-button mermaid-zoom-close"
        title={t().common.close}
        aria-label={t().common.close}
        onClick={() => props.onClose()}
      >
        <Icon name="x" size={18} />
      </button>
    </div>
  );
}

export default function MarkdownPreview(props: MarkdownPreviewProps): JSX.Element {
  const [html, setHtml] = createSignal("");
  const [zoomed, setZoomed] = createSignal<ZoomedDiagram | undefined>();

  let renderVersion = 0;

  createEffect(
    on(
      // mermaid はテーマの色を SVG に焼き込むので、切り替えたら描き直すしかない
      () => [props.source, resolvedTheme(), props.noteTitles] as const,
      async ([source, , noteTitles]) => {
        const currentVersion = ++renderVersion;
        if (!source) {
          setHtml("");
          return;
        }
        const rendered = await renderMarkdown(source, noteTitles);
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
