import { render, cleanup } from "@solidjs/testing-library";
import { page } from "vitest/browser";
import { describe, it, expect, afterEach } from "vitest";
import Icon from "./Icon";

describe("Icon", () => {
  afterEach(() => cleanup());

  it("renders an SVG for the given icon name", async () => {
    const { baseElement } = render(() => <Icon name="lightning" />);
    const screen = page.elementLocator(baseElement);

    await expect.element(screen.locator(".icon svg")).toBeInTheDocument();
  });

  it("applies the size prop to the SVG", async () => {
    const { baseElement } = render(() => <Icon name="lightning" size={16} />);
    const screen = page.elementLocator(baseElement);

    await expect.element(screen.locator(".icon svg")).toBeInTheDocument();
    const svg = baseElement.querySelector(".icon svg")!;
    expect(svg.getAttribute("width")).toBe("16px");
    expect(svg.getAttribute("height")).toBe("16px");
  });

  it("uses cached SVG on second render (no additional fetch)", async () => {
    const { baseElement: first } = render(() => <Icon name="sun" />);
    const screen1 = page.elementLocator(first);
    await expect.element(screen1.locator(".icon svg")).toBeInTheDocument();
    cleanup();

    const { baseElement: second } = render(() => <Icon name="sun" />);
    const screen2 = page.elementLocator(second);
    await expect.element(screen2.locator(".icon svg")).toBeInTheDocument();
  });
});
