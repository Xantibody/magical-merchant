import { cleanup, render } from "@solidjs/testing-library";
import { page } from "vitest/browser";
import { afterEach, describe, it, expect } from "vitest";
import ActionBar from "./ActionBar";

afterEach(() => cleanup());

describe("ActionBar", () => {
  it("renders children", async () => {
    const { baseElement } = render(() => (
      <ActionBar>
        <button>Test Action</button>
      </ActionBar>
    ));
    const screen = page.elementLocator(baseElement);

    await expect.element(screen.getByText("Test Action")).toBeInTheDocument();
  });

  it("has action-bar-zone and action-bar classes", async () => {
    const { baseElement } = render(() => (
      <ActionBar>
        <span>content</span>
      </ActionBar>
    ));

    expect(baseElement.querySelector(".action-bar-zone")).not.toBeNull();
    expect(baseElement.querySelector(".action-bar")).not.toBeNull();
  });
});
