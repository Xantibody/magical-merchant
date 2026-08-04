import { render, cleanup } from "@solidjs/testing-library";
import { page, userEvent } from "vitest/browser";
import { describe, it, expect, afterEach } from "vitest";
import MarkdownPreview from "./MarkdownPreview";

const FLOWCHART = ["```mermaid", "flowchart TD", "  A[Start] --> B[End]", "```"].join("\n");

describe("MarkdownPreview", () => {
  afterEach(() => cleanup());

  it("draws a mermaid fence as a diagram", async () => {
    const { baseElement } = render(() => <MarkdownPreview source={FLOWCHART} />);
    const screen = page.elementLocator(baseElement);

    await expect.element(screen.locator(".mermaid-block svg")).toBeInTheDocument();
  });

  it("opens the diagram full screen when it is tapped", async () => {
    const { baseElement } = render(() => <MarkdownPreview source={FLOWCHART} />);
    const screen = page.elementLocator(baseElement);

    await expect.element(screen.locator(".mermaid-block svg")).toBeInTheDocument();
    await userEvent.click(screen.locator(".mermaid-block"));

    await expect.element(screen.locator(".mermaid-zoom-canvas svg")).toBeInTheDocument();
  });

  it("closes the full screen diagram on Escape", async () => {
    const { baseElement } = render(() => <MarkdownPreview source={FLOWCHART} />);
    const screen = page.elementLocator(baseElement);

    await expect.element(screen.locator(".mermaid-block svg")).toBeInTheDocument();
    await userEvent.click(screen.locator(".mermaid-block"));
    await expect.element(screen.locator(".mermaid-zoom")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    await expect.element(screen.locator(".mermaid-zoom")).not.toBeInTheDocument();
  });

  it("leaves prose alone", async () => {
    const { baseElement } = render(() => <MarkdownPreview source="# 見出し" />);
    const screen = page.elementLocator(baseElement);

    await expect.element(screen.locator(".markdown-preview h1")).toBeInTheDocument();
    expect(baseElement.querySelector(".mermaid-block")).toBeNull();
  });
});
