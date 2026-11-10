import { render, cleanup } from "@solidjs/testing-library";
import { page } from "vitest/browser";
import { describe, it, expect, afterEach } from "vitest";
import MindmapView from "./MindmapView";

const OUTLINE = ["# 計画", "- 買い出し", "- 仕込み", "## 当日", "- 集合"].join("\n");

function query<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) {
    throw new Error(`見つからない: ${selector}`);
  }
  return el;
}

/** The scale d3-zoom wrote on markmap's drawing root; 0 before it wrote one. */
function scaleOf(svg: SVGSVGElement): number {
  const transform = svg.querySelector(":scope > g:not([class])")?.getAttribute("transform");
  return Number(/scale\((?<k>[\d.]+)\)/u.exec(transform ?? "")?.groups?.k ?? 0);
}

function sleep(ms: number): Promise<void> {
  // oxlint-disable-next-line promise/avoid-new
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("MindmapView", () => {
  afterEach(() => cleanup());

  it("見出しとリストの構造をマインドマップに描く", async () => {
    const { baseElement } = render(() => <MindmapView source={OUTLINE} />);
    const screen = page.elementLocator(baseElement);

    await expect
      .element(screen.locator(".mindmap-view svg g.markmap-node").first())
      .toBeInTheDocument();
    await expect.element(screen.locator(".mindmap-view svg")).toHaveTextContent("買い出し");
    await expect.element(screen.locator(".mindmap-view svg")).toHaveTextContent("当日");
  });

  it("本文が変わったら描き直す", async () => {
    const [source, setSource] = await import("solid-js").then((m) => m.createSignal("# 前の本文"));
    const { baseElement } = render(() => <MindmapView source={source()} />);
    const screen = page.elementLocator(baseElement);

    await expect.element(screen.locator(".mindmap-view svg")).toHaveTextContent("前の本文");

    setSource("# 後の本文");

    await expect.element(screen.locator(".mindmap-view svg")).toHaveTextContent("後の本文");
  });

  describe("描く場所の大きさに合わせる", () => {
    // On a phone the list picks a note while the detail pane is display: none. Fitted at
    // 0 × 0, the map was scale(0) and stayed empty once the pane opened
    it("隠れたまま開かれても、見えたときに全体が収まる", async () => {
      const { baseElement } = render(() => (
        <div class="hidden-pane" style={{ display: "none" }}>
          <MindmapView source={OUTLINE} />
        </div>
      ));
      const svg = query<SVGSVGElement>(baseElement, ".mindmap-view svg");
      await sleep(200);

      query<HTMLDivElement>(baseElement, ".hidden-pane").style.display = "block";

      await expect.poll(() => scaleOf(svg)).toBeGreaterThan(0);
      await expect.element(page.elementLocator(svg)).toHaveTextContent("買い出し");
    });

    it("描く場所の大きさが変わったら収め直す", async () => {
      const { baseElement } = render(() => <MindmapView source={OUTLINE} />);
      const svg = query<SVGSVGElement>(baseElement, ".mindmap-view svg");
      svg.style.width = "200px";
      svg.style.height = "100px";
      await expect.poll(() => scaleOf(svg)).toBeGreaterThan(0);
      const small = scaleOf(svg);

      svg.style.width = "800px";
      svg.style.height = "400px";

      await expect.poll(() => scaleOf(svg)).not.toBe(small);
    });
  });

  describe("ダブルクリックで拡大しない", () => {
    // The transform on markmap's drawing root, the unnamed `<g>` directly under the
    // `<svg>`. d3-zoom writes scale and pan there, so if it does not move, nothing zoomed
    async function renderAndSettle(baseElement: HTMLElement) {
      const screen = page.elementLocator(baseElement);
      await expect
        .element(screen.locator(".mindmap-view svg g.markmap-node").first())
        .toBeInTheDocument();
      const svg = query<SVGSVGElement>(baseElement, ".mindmap-view svg");
      const rootGroup = query<SVGGElement>(svg, ":scope > g:not([class])");
      // markmap's `fit()` goes through a d3 transition even at duration 0, so we have to
      // wait until the initial transform is written to read the "before" value
      await expect.poll(() => rootGroup.getAttribute("transform")).toBeTruthy();
      return { svg, rootGroup, before: rootGroup.getAttribute("transform") };
    }

    // d3-zoom's double-click zoom runs as a 250ms transition, so claiming "it did not
    // change" means waiting that long and watching it
    async function expectTransformUnchanged(rootGroup: SVGGElement, before: string | null) {
      await sleep(400);
      expect(rootGroup.getAttribute("transform")).toBe(before);
    }

    it("折りたたみの丸をダブルクリックしても拡大しない", async () => {
      const { baseElement } = render(() => <MindmapView source={OUTLINE} />);
      const { svg, rootGroup, before } = await renderAndSettle(baseElement);
      const circle = query<SVGCircleElement>(svg, "g.markmap-node > circle");

      circle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 10, clientY: 10 }));

      await expectTransformUnchanged(rootGroup, before);
    });

    it("余白をダブルクリックしても拡大しない", async () => {
      const { baseElement } = render(() => <MindmapView source={OUTLINE} />);
      const { svg, rootGroup, before } = await renderAndSettle(baseElement);

      svg.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 10, clientY: 10 }));

      await expectTransformUnchanged(rootGroup, before);
    });
  });
});
