import { describe, it, expect, afterEach } from "vitest";
import { getShikiTheme, nextTheme } from "./theme";

describe("getShikiTheme", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  it("returns github-dark-default when data-theme is dark", () => {
    document.documentElement.dataset.theme = "dark";
    expect(getShikiTheme()).toBe("github-dark-default");
  });

  it("returns github-light-default when data-theme is light", () => {
    document.documentElement.dataset.theme = "light";
    expect(getShikiTheme()).toBe("github-light-default");
  });

  it("defaults to github-dark-default when data-theme is not set", () => {
    expect(getShikiTheme()).toBe("github-dark-default");
  });
});

describe("nextTheme", () => {
  it("cycles light → dark → system → light", () => {
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("system");
    expect(nextTheme("system")).toBe("light");
  });

  it("comes back to where it started after one round", () => {
    expect(nextTheme(nextTheme(nextTheme("light")))).toBe("light");
  });
});
