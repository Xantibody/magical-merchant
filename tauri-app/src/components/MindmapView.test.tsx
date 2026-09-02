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

  describe("ダブルクリックで拡大しない", () => {
    // markmap の描画ルート (<svg> 直下の無名 <g>) の transform。d3-zoom は
    // ここに拡大・移動を書き込むので、これが動かなければズームしていない
    async function renderAndSettle(baseElement: HTMLElement) {
      const screen = page.elementLocator(baseElement);
      await expect
        .element(screen.locator(".mindmap-view svg g.markmap-node").first())
        .toBeInTheDocument();
      const svg = query<SVGSVGElement>(baseElement, ".mindmap-view svg");
      const rootGroup = query<SVGGElement>(svg, ":scope > g:not([class])");
      // fit() は duration 0 でも d3 の transition 経由なので、初期 transform が
      // 書かれるまで待たないと「前」の値が取れない
      await expect.poll(() => rootGroup.getAttribute("transform")).toBeTruthy();
      return { svg, rootGroup, before: rootGroup.getAttribute("transform") };
    }

    // d3-zoom のダブルクリック拡大は 250ms の transition で動くので、
    // 「変わらなかった」と言うにはその時間ぶん待って見届ける必要がある
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
