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
    // 合図はブロックから浮かんでエディタまで届く
    expect(settled).toHaveBeenCalledTimes(1);
  });

  // 打鍵のたびに走る sync が、待っていない相手に合図を投げ続けないこと
  it("stays quiet when nothing was pending", () => {
    const { root, dom } = block();
    const settled = vi.fn<() => void>();
    root.addEventListener(DIAGRAM_SETTLED_EVENT, settled);

    setDiagramPending(dom, false);

    expect(settled).not.toHaveBeenCalled();
  });

  // 図が 2 つあるノートは、両方が決着するまで「まだ描いている」
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
