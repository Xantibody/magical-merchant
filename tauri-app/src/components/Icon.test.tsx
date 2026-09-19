import { render, cleanup } from "@solidjs/testing-library";
import { page } from "vitest/browser";
import { describe, it, expect, afterEach } from "vitest";
import Icon from "./Icon";

function query<T extends Element = Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) {
    throw new Error(`expected ${selector} to render`);
  }
  return found;
}

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
    const svg = query(baseElement, ".icon svg");
    expect(svg.getAttribute("width")).toBe("16px");
    expect(svg.getAttribute("height")).toBe("16px");
  });

  it("reserves the icon box before the SVG arrives", () => {
    // SVG は動的 import で遅れて届く。それまで span が 0px だと、届いた瞬間に
    // 周りのレイアウトが育って画面全体が揺れる(起動時 CLS の主因だった)
    const { baseElement } = render(() => <Icon name="caret-left" size={18} />);
    const span = query<HTMLSpanElement>(baseElement, ".icon");
    expect(span.style.width).toBe("18px");
    expect(span.style.height).toBe("18px");
  });

  it("reserves the default 24px box when no size is given", () => {
    const { baseElement } = render(() => <Icon name="caret-right" />);
    const span = query<HTMLSpanElement>(baseElement, ".icon");
    expect(span.style.width).toBe("24px");
    expect(span.style.height).toBe("24px");
  });

  it("renders a fill weight icon from the fill asset directory", async () => {
    // fill ウェイトは assets/fill/ の別ファイル。登録が regular を指したままでも
    // SVG 自体は描けてしまうので、regular と形が違うことまで確かめる
    const { baseElement: regular } = render(() => <Icon name="push-pin" />);
    const regularScreen = page.elementLocator(regular);
    await expect.element(regularScreen.locator(".icon svg")).toBeInTheDocument();
    const regularPath = query(regular, ".icon svg path").getAttribute("d");
    cleanup();

    const { baseElement: filled } = render(() => <Icon name="push-pin-fill" />);
    const filledScreen = page.elementLocator(filled);
    await expect.element(filledScreen.locator(".icon svg")).toBeInTheDocument();
    expect(query(filled, ".icon svg path").getAttribute("d")).not.toBe(regularPath);
  });

  it("renders correctly on second render with the same icon name", async () => {
    const { baseElement: first } = render(() => <Icon name="sun" />);
    const screen1 = page.elementLocator(first);
    await expect.element(screen1.locator(".icon svg")).toBeInTheDocument();
    cleanup();

    const { baseElement: second } = render(() => <Icon name="sun" />);
    const screen2 = page.elementLocator(second);
    await expect.element(screen2.locator(".icon svg")).toBeInTheDocument();
  });
});
