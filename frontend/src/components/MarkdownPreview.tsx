import { createSignal, createEffect, on, onCleanup, Show } from "solid-js";
import copyIcon from "@phosphor-icons/core/assets/regular/copy.svg?raw";
import checkIcon from "@phosphor-icons/core/assets/regular/check.svg?raw";
import { typedInvoke } from "../lib/commands";
import { createCopyFeedback } from "../lib/copy-feedback";
import { exportName, rasterize, sizedSvg, textToBase64 } from "../lib/diagram-export";
import { t } from "../lib/i18n";
import { renderMarkdown } from "../lib/markdown";
import { resolvedTheme } from "../lib/theme";
import { zoomSize } from "../lib/zoom-transform";
import DiagramZoom from "./DiagramZoom";
import "../styles/markdown-preview.css";
import type { ExportFormat } from "../lib/diagram-export";
import type { LineMark } from "../lib/diff-marks";
import type { ZoomedDiagram } from "./DiagramZoom";
import type { JSX } from "solid-js";

interface MarkdownPreviewProps {
  source: string;
  /** Lookup table that draws `[[ID]]` as a title. Without it the stored form shows. */
  noteTitles?: ReadonlyMap<string, string>;
  /** Registry that draws `:name:` as an image. Without it the stored form shows. */
  glyphs?: ReadonlyMap<string, string>;
  /** Leading part of the filename when exporting a diagram. The note's stem. Without it, a generic name */
  exportStem?: string;
  /** Text shown to the user when an export fails. Without it, the failure is silent */
  onError?: (message: string) => void;
  /**
   * Per-line marks while the history is open (`lib/diff-marks.ts`). When given,
   * +/- stand in the margin. Neither the body's colour nor its text changes.
   */
  marks?: readonly (LineMark | undefined)[];
}

/** Time until the check shown after a copy is reset. Same as the editor's node view */
const COPY_RESET_MS = 1500;

/** The diagram the pressed tool belongs to. Tool icons are svg too, so narrow by the figure container */
function diagramOf(from: Element): { figure: Element; svg: SVGSVGElement } | undefined {
  const figure = from.closest(".mermaid-block");
  const svg = figure?.querySelector<SVGSVGElement>(".mermaid-figure svg");
  return figure && svg ? { figure, svg } : undefined;
}

/** The PNG background. Left transparent, the lines vanish in a viewer with a dark background */
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
      // mermaid bakes the theme colours into the SVG, so a theme switch forces a
      // redraw. The tool labels are baked into the output too, so a language change redraws as well
      () =>
        [props.source, resolvedTheme(), props.noteTitles, props.glyphs, t(), props.marks] as const,
      async ([source, , noteTitles, glyphs, , marks]) => {
        const currentVersion = ++renderVersion;
        if (!source) {
          setHtml("");
          return;
        }
        const rendered = await renderMarkdown(source, noteTitles, glyphs, marks);
        if (currentVersion === renderVersion) {
          setHtml(rendered);
        }
      },
    ),
  );

  // The button showing "copied". The tools live inside innerHTML, so a signal
  // cannot hold them; the pressed button itself is marked. Losing the mark on a redraw is fine
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
    // Moving to another block takes the previous mark down. There is only one reset timer, for the last copy
    if (copiedButton !== button) {
      applyCopyState(false);
      copiedButton = button;
    }
    copyFeedback.copy(source);
  };

  // Unlike the body, a diagram cannot wrap. On a narrow screen it is shrunk to
  // fit the width and opens at full size only when pressed
  const openZoom = (from: Element): void => {
    const diagram = diagramOf(from);
    if (!diagram) {
      return;
    }
    const { svg } = diagram;
    const size = zoomSize(svg.viewBox.baseVal, svg.getBoundingClientRect());
    // A diagram that cannot be measured does not open. Opened with no measurable size it is a white screen with only a close button
    if (!size) {
      return;
    }
    setZoomed({ svg: svg.outerHTML, ...size });
  };

  /** To the native save dialog. Cancel is not a failure, so it says nothing */
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

  /** The tools sit as static HTML inside the render output, so presses are received in this one place */
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
        classList={{ "markdown-preview--marked": props.marks !== undefined }}
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
