import { describe, it, expect, afterEach } from "vitest";
import { getShikiTheme } from "./theme";

describe("getShikiTheme", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
  });

  it("returns github-dark-default when data-theme is dark", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    expect(getShikiTheme()).toBe("github-dark-default");
  });

  it("returns github-light-default when data-theme is light", () => {
    document.documentElement.setAttribute("data-theme", "light");
    expect(getShikiTheme()).toBe("github-light-default");
  });

  it("defaults to github-dark-default when data-theme is not set", () => {
    expect(getShikiTheme()).toBe("github-dark-default");
  });
});
