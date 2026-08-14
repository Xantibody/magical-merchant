import { render, cleanup } from "@solidjs/testing-library";
import { page } from "vitest/browser";
import { describe, it, expect, afterEach } from "vitest";
import MindmapView from "./MindmapView";

const OUTLINE = ["# 計画", "- 買い出し", "- 仕込み", "## 当日", "- 集合"].join("\n");

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
    const [source, setSource] = await import("solid-js").then((m) =>
      m.createSignal("# 前の本文"),
    );
    const { baseElement } = render(() => <MindmapView source={source()} />);
    const screen = page.elementLocator(baseElement);

    await expect.element(screen.locator(".mindmap-view svg")).toHaveTextContent("前の本文");

    setSource("# 後の本文");

    await expect.element(screen.locator(".mindmap-view svg")).toHaveTextContent("後の本文");
  });
});
