import { render, cleanup } from "@solidjs/testing-library";
import { page, userEvent } from "vitest/browser";
import type { Locator } from "vitest/browser";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import MarkdownPreview from "./MarkdownPreview";

const FLOWCHART = ["```mermaid", "flowchart TD", "  A[Start] --> B[End]", "```"].join("\n");

/** コマンドに渡った base64 を文字列に戻す */
function decodeBase64(base64: string): string {
  return new TextDecoder().decode(
    Uint8Array.from(atob(base64), (char) => char.codePointAt(0) ?? 0),
  );
}

/** SVG の開始タグだけ。mermaid の <style> の中の max-width は図の体裁で、見たいのはルートの属性 */
function openingTagOf(svg: string): string {
  return svg.match(/^<svg[^>]*>/u)?.[0] ?? "";
}

/** 右下の倍率表示を数で読む */
function percentOf(locator: Locator): number {
  return Number.parseInt(locator.element().textContent ?? "", 10);
}

describe("MarkdownPreview", () => {
  afterEach(() => cleanup());

  it("draws a mermaid fence as a diagram", async () => {
    const { baseElement } = render(() => <MarkdownPreview source={FLOWCHART} />);
    const screen = page.elementLocator(baseElement);

    await expect.element(screen.locator(".mermaid-figure svg")).toBeInTheDocument();
  });

  it("opens the diagram full screen when it is tapped", async () => {
    const { baseElement } = render(() => <MarkdownPreview source={FLOWCHART} />);
    const screen = page.elementLocator(baseElement);

    await expect.element(screen.locator(".mermaid-figure svg")).toBeInTheDocument();
    await userEvent.click(screen.locator(".mermaid-block"));

    await expect.element(screen.locator(".mermaid-zoom-canvas svg")).toBeInTheDocument();
  });

  it("closes the full screen diagram on Escape", async () => {
    const { baseElement } = render(() => <MarkdownPreview source={FLOWCHART} />);
    const screen = page.elementLocator(baseElement);

    await expect.element(screen.locator(".mermaid-figure svg")).toBeInTheDocument();
    await userEvent.click(screen.locator(".mermaid-block"));
    await expect.element(screen.locator(".mermaid-zoom")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    await expect.element(screen.locator(".mermaid-zoom")).not.toBeInTheDocument();
  });

  it("fits the diagram to the screen when it opens and zooms in from the controls", async () => {
    const { baseElement } = render(() => <MarkdownPreview source={FLOWCHART} />);
    const screen = page.elementLocator(baseElement);

    await expect.element(screen.locator(".mermaid-figure svg")).toBeInTheDocument();
    await userEvent.click(screen.locator(".mermaid-block"));
    const canvas = screen.locator(".mermaid-zoom-canvas");
    await expect.element(canvas).toBeInTheDocument();

    // 開いた直後から transform が付いている(fit)。原寸の 2 倍まで
    const before = (canvas.element() as HTMLElement).style.transform;
    expect(before).toMatch(/^translate\(.+\) scale\(.+\)$/u);
    const percent = screen.locator(".mermaid-zoom-percent");
    const fitted = percentOf(percent);
    expect(fitted).toBeGreaterThan(0);
    expect(fitted).toBeLessThanOrEqual(200);

    await userEvent.click(screen.getByRole("button", { name: "大きく" }));

    await expect.element(percent).toHaveTextContent(`${Math.round(fitted * 1.25)}%`);
    expect((canvas.element() as HTMLElement).style.transform).not.toBe(before);
  });

  it("zooms toward the wheel without closing", async () => {
    const { baseElement } = render(() => <MarkdownPreview source={FLOWCHART} />);
    const screen = page.elementLocator(baseElement);

    await expect.element(screen.locator(".mermaid-figure svg")).toBeInTheDocument();
    await userEvent.click(screen.locator('[data-action="zoom"]'));
    const zoom = screen.locator(".mermaid-zoom");
    await expect.element(zoom).toBeInTheDocument();
    const percent = screen.locator(".mermaid-zoom-percent");
    const fitted = percentOf(percent);

    const wheel = new WheelEvent("wheel", {
      deltaY: -300,
      clientX: 10,
      clientY: 10,
      bubbles: true,
      cancelable: true,
    });
    zoom.element().dispatchEvent(wheel);

    // preventDefault されていれば、ページのスクロールやブラウザのズームには渡らない
    expect(wheel.defaultPrevented).toBe(true);
    const zoomed = percentOf(percent);
    expect(zoomed).toBeGreaterThan(fitted);
    // 背景を押しても閉じない — ドラッグの始点と区別が付かないので
    await userEvent.click(zoom);
    await expect.element(zoom).toBeInTheDocument();
  });

  it("leaves prose alone", async () => {
    const { baseElement } = render(() => <MarkdownPreview source="# 見出し" />);
    const screen = page.elementLocator(baseElement);

    await expect.element(screen.locator(".markdown-preview h1")).toBeInTheDocument();
    expect(baseElement.querySelector(".mermaid-block")).toBeNull();
  });

  it("opens the diagram from its zoom tool", async () => {
    const { baseElement } = render(() => <MarkdownPreview source={FLOWCHART} />);
    const screen = page.elementLocator(baseElement);

    await expect.element(screen.locator(".mermaid-figure svg")).toBeInTheDocument();
    await userEvent.click(screen.locator('[data-action="zoom"]'));

    await expect.element(screen.locator(".mermaid-zoom-canvas svg")).toBeInTheDocument();
  });

  describe("export tools", () => {
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];

    beforeEach(() => {
      calls.length = 0;
      mockIPC((cmd, args) => {
        calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
        return { saved: true };
      });
    });

    afterEach(() => clearMocks());

    it("hands the sized svg to the save command, named after the note", async () => {
      const { baseElement } = render(() => (
        <MarkdownPreview source={FLOWCHART} exportStem="20260903_101010" />
      ));
      const screen = page.elementLocator(baseElement);

      await expect.element(screen.locator(".mermaid-figure svg")).toBeInTheDocument();
      await userEvent.click(screen.locator('[data-action="svg"]'));

      await expect.poll(() => calls.map((call) => call.cmd)).toStrictEqual(["save_export"]);
      expect(calls[0].args.suggestedName).toBe("20260903_101010-1.svg");
      const opening = openingTagOf(decodeBase64(calls[0].args.dataBase64 as string));
      expect(opening).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(opening).not.toContain("max-width");
    });

    it("hands a png to the save command", async () => {
      const { baseElement } = render(() => <MarkdownPreview source={FLOWCHART} />);
      const screen = page.elementLocator(baseElement);

      await expect.element(screen.locator(".mermaid-figure svg")).toBeInTheDocument();
      await userEvent.click(screen.locator('[data-action="png"]'));

      await expect.poll(() => calls.map((call) => call.cmd)).toStrictEqual(["save_export"]);
      expect(calls[0].args.suggestedName).toBe("diagram-1.png");
      // PNG の先頭 8 バイト (\x89PNG\r\n\x1a\n) の base64
      expect(calls[0].args.dataBase64).toMatch(/^iVBORw0KGgo/u);
    });

    it("reports a failed save instead of staying silent", async () => {
      mockIPC(() => {
        throw new Error("disk full");
      });
      const errors: string[] = [];
      const { baseElement } = render(() => (
        <MarkdownPreview source={FLOWCHART} onError={(message) => errors.push(message)} />
      ));
      const screen = page.elementLocator(baseElement);

      await expect.element(screen.locator(".mermaid-figure svg")).toBeInTheDocument();
      await userEvent.click(screen.locator('[data-action="svg"]'));

      await expect.poll(() => errors).toStrictEqual(["図を保存できませんでした"]);
    });
  });

  describe("copy tool", () => {
    const written: string[] = [];
    const clipboard = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard");

    beforeEach(() => {
      written.length = 0;
      // ヘッドレスの Chromium はクリップボードへの書き込みを許可しない。
      // 見たいのは「押したブロックの生ソースが渡ること」だけ
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (text: string) => {
            written.push(text);
            return Promise.resolve();
          },
        },
      });
    });

    afterEach(() => {
      if (clipboard) {
        Object.defineProperty(Navigator.prototype, "clipboard", clipboard);
      }
      // インスタンス側に置いた上書きを外し、プロトタイプの本物に戻す
      Reflect.deleteProperty(navigator, "clipboard");
    });

    it("copies the fence source of the block it sits in", async () => {
      const source = ["```ts", "const a = 1;", "```", "", "```ts", "const b = 2;", "```"].join(
        "\n",
      );
      const { baseElement } = render(() => <MarkdownPreview source={source} />);
      const screen = page.elementLocator(baseElement);

      await expect.element(screen.locator("pre").nth(1)).toBeInTheDocument();
      await userEvent.click(screen.locator('[data-action="copy"]').nth(1));

      await expect.poll(() => written).toStrictEqual(["const b = 2;\n"]);
      await expect.element(screen.locator('[data-action="copy"]').nth(1)).toHaveClass("is-copied");
      await expect
        .element(screen.locator('[data-action="copy"]').nth(0))
        .not.toHaveClass("is-copied");
    });
  });
});
