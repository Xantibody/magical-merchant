import { describe, it, expect, vi } from "vitest";
import {
  DIAGRAM_PENDING_CLASS,
  DIAGRAM_SETTLED_EVENT,
  hasPendingDiagram,
  setDiagramPending,
} from "./diagram-pending";

function block(): { root: HTMLElement; dom: HTMLElement } {
  const root = document.createElement("div");
  const dom = document.createElement("div");
  root.append(dom);
  return { root, dom };
}

describe("diagram pending", () => {
  it("tells the waiting side a diagram has no height yet", () => {
    const { root, dom } = block();

    expect(hasPendingDiagram(root)).toBe(false);

    setDiagramPending(dom, true);

    expect(hasPendingDiagram(root)).toBe(true);
    expect(dom.classList.contains(DIAGRAM_PENDING_CLASS)).toBe(true);
  });

  it("signals the waiting side when the height is settled", () => {
    const { root, dom } = block();
    const settled = vi.fn<() => void>();
    root.addEventListener(DIAGRAM_SETTLED_EVENT, settled);

    setDiagramPending(dom, true);
    setDiagramPending(dom, false);

    expect(hasPendingDiagram(root)).toBe(false);
    // The event bubbles out of the block and reaches the editor
    expect(settled).toHaveBeenCalledTimes(1);
  });

  // The sync that runs on every keystroke must not keep firing the event at a side that
  // is not waiting
  it("stays quiet when nothing was pending", () => {
    const { root, dom } = block();
    const settled = vi.fn<() => void>();
    root.addEventListener(DIAGRAM_SETTLED_EVENT, settled);

    setDiagramPending(dom, false);

    expect(settled).not.toHaveBeenCalled();
  });

  // A note with two diagrams is "still drawing" until both are settled
  it("stays pending while any diagram is still drawing", () => {
    const { root, dom } = block();
    const other = document.createElement("div");
    root.append(other);

    setDiagramPending(dom, true);
    setDiagramPending(other, true);
    setDiagramPending(dom, false);

    expect(hasPendingDiagram(root)).toBe(true);

    setDiagramPending(other, false);

    expect(hasPendingDiagram(root)).toBe(false);
  });
});
