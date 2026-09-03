import { createSignal, createEffect, on, onCleanup, Show } from "solid-js";
import copyIcon from "@phosphor-icons/core/assets/regular/copy.svg?raw";
import checkIcon from "@phosphor-icons/core/assets/regular/check.svg?raw";
import { typedInvoke } from "../lib/commands";
import { createCopyFeedback } from "../lib/copy-feedback";
import { exportName, rasterize, sizedSvg, textToBase64 } from "../lib/diagram-export";
import { t } from "../lib/i18n";
import { renderMarkdown } from "../lib/markdown";
import { resolvedTheme } from "../lib/theme";
import DiagramZoom from "./DiagramZoom";
import "../styles/markdown-preview.css";
import type { ExportFormat } from "../lib/diagram-export";
import type { ZoomedDiagram } from "./DiagramZoom";
import type { JSX } from "solid-js";

interface MarkdownPreviewProps {
  source: string;
  /** `[[ID]]` をタイトルで描くための解決表。無ければ保存形のまま出る。 */
  noteTitles?: ReadonlyMap<string, string>;
  /** `:name:` を画像で描くための登録表。無ければ保存形のまま出る。 */
  glyphs?: ReadonlyMap<string, string>;
  /** 図を書き出すときのファイル名の頭。ノートの stem。無ければ generic な名前 */
  exportStem?: string;
  /** 書き出しに失敗したとき、利用者に見せる文。無ければ黙って失敗する */
  onError?: (message: string) => void;
}

/** コピー後にチェック表示を戻すまでの時間。エディタの node view と同じ */
const COPY_RESET_MS = 1500;

/** 押された道具が属する図。道具のアイコンも svg なので、図の入れ物で絞る */
function diagramOf(from: Element): { figure: Element; svg: SVGSVGElement } | undefined {
  const figure = from.closest(".mermaid-block");
  const svg = figure?.querySelector<SVGSVGElement>(".mermaid-figure svg");
  return figure && svg ? { figure, svg } : undefined;
}

/** PNG の下地。透明のままだと暗い背景のビューアで線が消える */
function surfaceColor(): string {
  const color = getComputedStyle(document.documentElement).getPropertyValue("--app-surface");
  return color.trim() || "#ffffff";
}

export default function MarkdownPreview(props: MarkdownPreviewProps): JSX.Element {
  const [html, setHtml] = createSignal("");
  const [zoomed, setZoomed] = createSignal<ZoomedDiagram | undefined>();

  let root: HTMLDivElement | undefined;
  let renderVersion = 0;

  createEffect(
    on(
      // mermaid はテーマの色を SVG に焼き込むので、切り替えたら描き直すしかない。
      // 道具のラベルも描画結果に焼き込まれるので、言語が変わっても描き直す
      () => [props.source, resolvedTheme(), props.noteTitles, props.glyphs, t()] as const,
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

  // 「コピー済み」を出しているボタン。道具は innerHTML の中にあるので signal では
  // 持てず、押されたボタンそのものに印を付ける。描き直しで外れても構わない
  let copiedButton: HTMLElement | undefined;

  const applyCopyState = (copied: boolean): void => {
    if (!copiedButton) {
      return;
    }
    copiedButton.classList.toggle("is-copied", copied);
    copiedButton.innerHTML = copied ? checkIcon : copyIcon;
  };

  const copyFeedback = createCopyFeedback(
    (text) => navigator.clipboard.writeText(text),
    applyCopyState,
    COPY_RESET_MS,
  );
  onCleanup(() => copyFeedback.dispose());

  const copyBlock = (button: HTMLElement): void => {
    const source = button.closest("pre")?.dataset.source;
    if (source === undefined) {
      return;
    }
    // 別のブロックへ移ったら前の印は下ろす。戻すタイマーは最後の 1 回分しか無い
    if (copiedButton !== button) {
      applyCopyState(false);
      copiedButton = button;
    }
    copyFeedback.copy(source);
  };

  // 図は本文と違って折り返せない。狭い画面では幅に合わせて縮めておき、
  // 押されたときだけ原寸で開く
  const openZoom = (from: Element): void => {
    const diagram = diagramOf(from);
    if (!diagram) {
      return;
    }
    // 原寸は viewBox。mermaid が max-width に書く値と同じだが、数値で欲しい。
    // viewBox を持たない SVG は縮めて描いている今の大きさを原寸とみなす
    const { svg } = diagram;
    const box = svg.viewBox.baseVal;
    const rect = svg.getBoundingClientRect();
    setZoomed({
      svg: svg.outerHTML,
      width: box.width > 0 ? box.width : rect.width,
      height: box.height > 0 ? box.height : rect.height,
    });
  };

  /** ネイティブの保存ダイアログへ。キャンセルは失敗ではないので何も言わない */
  const exportDiagram = async (from: Element, format: ExportFormat): Promise<void> => {
    const diagram = diagramOf(from);
    if (!diagram) {
      return;
    }
    const figures = [...(root?.querySelectorAll(".mermaid-block") ?? [])];
    const index = figures.indexOf(diagram.figure) + 1;
    try {
      const source = diagram.svg.outerHTML;
      const dataBase64 =
        format === "svg" ? textToBase64(sizedSvg(source)) : await rasterize(source, surfaceColor());
      await typedInvoke("save_export", {
        suggestedName: exportName(props.exportStem, index, format),
        dataBase64,
      });
    } catch {
      props.onError?.(t().preview.exportFailed);
    }
  };

  /** 道具は描画結果の中に静的な HTML で居るので、押されたものをここで 1 か所で受ける */
  const onClick = (e: MouseEvent): void => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) {
      return;
    }
    const tool = target.closest<HTMLElement>("[data-action]");
    if (!tool) {
      if (target.closest(".mermaid-block")) {
        openZoom(target);
      }
      return;
    }
    switch (tool.dataset.action) {
      case "copy": {
        copyBlock(tool);
        break;
      }
      case "zoom": {
        openZoom(tool);
        break;
      }
      case "svg":
      case "png": {
        void exportDiagram(tool, tool.dataset.action);
        break;
      }
      default: {
        break;
      }
    }
  };

  return (
    <>
      <div
        ref={root}
        class="markdown-preview"
        innerHTML={html()}
        onClick={onClick}
        role="presentation"
      />

      <Show when={zoomed()}>
        {(diagram) => <DiagramZoom diagram={diagram()} onClose={() => setZoomed(undefined)} />}
      </Show>
    </>
  );
}
