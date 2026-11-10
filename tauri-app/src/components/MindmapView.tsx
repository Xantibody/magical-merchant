import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { Markmap } from "markmap-view";
import { outlineToTree } from "../lib/mindmap";

interface MindmapViewProps {
  source: string;
}

/**
 * Remove only the double-click 2x zoom that d3-zoom attaches by default.
 * markmap stops dblclick on labels (foreignObject) but not on the fold circles
 * or the empty space, so a double tap there zoomed in unintentionally.
 * `zoom: false` would also remove wheel and pinch zoom, so the listener is
 * targeted by its namespace "dblclick.zoom".
 */
function disableDoubleClickZoom(mm: Markmap): void {
  mm.svg.on("dblclick.zoom", null);
}

/**
 * A read-only view that draws the body's heading and list structure as a mindmap.
 * This component is lazy imported from Workspace. markmap-view is a heavy
 * dependency that brings d3 along, so like mermaid only the notes that use it pay for it.
 */
export default function MindmapView(props: MindmapViewProps): JSX.Element {
  let svgRef: SVGSVGElement | undefined;
  let markmap: Markmap | undefined;
  /**
   * Whether the svg has a box to draw in. On a phone the list picks a note while the detail
   * pane is display: none; drawn then, fit() measures 0 × 0 and writes scale(0), and nothing
   * fits again when the pane opens. So nothing is drawn until there is room.
   *
   * AIDEV-NOTE: not "draw anyway, fit once the box appears". The labels were measured at 0 as
   * well, and markmap lays them out again on its own 100ms later without fitting, so that fit
   * would size the map from the collapsed layout
   */
  const [hasRoom, setHasRoom] = createSignal(false);

  createEffect(() => {
    const root = outlineToTree(props.source);
    if (!svgRef || !hasRoom()) {
      return;
    }
    // duration: 0. The whole map should be visible the moment it opens. The
    // animation of branches growing out is decoration in a read-only view, and
    // it also leaves d3 transitions hanging after disposal.
    // The data is not passed to create. If it were, markmap would chain setData
    // into fit internally, and fit would run even after disposal and try to read
    // the size of a detached SVG
    markmap ??= Markmap.create(svgRef, { duration: 0 });
    const current = markmap;
    disableDoubleClickZoom(current);
    void (async () => {
      // An incremental update, not clear and rebuild. Branches the user folded survive here
      await current.setData(root);
      // Passing options to setData makes markmap reattach zoom, so remove it
      // again afterwards. No options are passed now, but it is a one-line safeguard, so do it every time
      disableDoubleClickZoom(current);
      if (markmap === current) {
        await current.fit();
      }
    })();
  });

  onMount(() => {
    if (!svgRef) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      const room = width > 0 && height > 0;
      // Only the box changed (a rotated phone, the note panel docking): the labels keep their
      // size, so fitting again is enough. Gaining room at all goes through the effect above
      if (room && hasRoom()) {
        void markmap?.fit();
      }
      setHasRoom(room);
    });
    observer.observe(svgRef);
    onCleanup(() => observer.disconnect());
  });

  onCleanup(() => {
    // Detaching the SVG while a fit() transition is still running makes d3 crash
    // reading the size of a detached element. destroy does not stop the transition
    markmap?.svg.interrupt();
    markmap?.destroy();
    markmap = undefined;
  });

  return (
    <div class="mindmap-view">
      <svg ref={svgRef} />
    </div>
  );
}
