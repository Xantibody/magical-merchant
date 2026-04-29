import { render, cleanup } from "@solidjs/testing-library";
import { page } from "vitest/browser";
import { describe, it, expect, afterEach } from "vitest";
import { Router, Route } from "@solidjs/router";
import ToggleMenu from "./ToggleMenu";

describe("ToggleMenu", () => {
  afterEach(() => cleanup());

  const renderMenu = (isOpen = true) =>
    render(() => (
      <Router root={() => <ToggleMenu isOpen={() => isOpen} onClose={() => {}} />}>
        <Route path="/" component={() => <div />} />
        <Route path="/notes" component={() => <div />} />
        <Route path="/tasks" component={() => <div />} />
        <Route path="/settings" component={() => <div />} />
      </Router>
    ));

  it("renders four navigation links", async () => {
    const { baseElement } = renderMenu();
    const screen = page.elementLocator(baseElement);

    await expect.element(screen.getByText("Timeline")).toBeInTheDocument();
    await expect.element(screen.getByText("Notes")).toBeInTheDocument();
    await expect.element(screen.getByText("Tasks")).toBeInTheDocument();
    await expect.element(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("has correct href for each link", async () => {
    const { baseElement } = renderMenu();
    const screen = page.elementLocator(baseElement);

    await expect.element(screen.getByText("Timeline")).toBeInTheDocument();
    const links = baseElement.querySelectorAll("a.toggle-menu-item");
    const hrefs = Array.from(links).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/", "/notes", "/tasks", "/settings"]);
  });
});
