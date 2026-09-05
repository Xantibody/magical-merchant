import { describe, it, expect, afterEach } from "vitest";
import { chooseTheme, getShikiTheme, theme } from "./theme";

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

describe("chooseTheme", () => {
  afterEach(() => {
    chooseTheme("system");
    localStorage.removeItem("theme");
    delete document.documentElement.dataset.theme;
  });

  // 選ぶのは Settings、当たっている色を読むのは他の画面。同じ値を見せる
  it("paints the document and remembers the choice", () => {
    chooseTheme("dark");

    expect(theme()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("theme")).toBe("dark");
  });

  // system は「今の端末の色」に解決するが、覚えるのは system のまま
  it("keeps system as system while resolving it for the document", () => {
    chooseTheme("system");

    expect(theme()).toBe("system");
    expect(localStorage.getItem("theme")).toBe("system");
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
