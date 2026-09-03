import { onCleanup, onMount } from "solid-js";
import { t } from "../lib/i18n";
import Icon from "./Icon";
import type { JSX } from "solid-js";

export interface ZoomedDiagram {
  svg: string;
  /** 図の原寸。mermaid が SVG の max-width に書き込んだ値をそのまま使う */
  width: string;
}

export default function DiagramZoom(props: {
  diagram: ZoomedDiagram;
  onClose: () => void;
}): JSX.Element {
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
