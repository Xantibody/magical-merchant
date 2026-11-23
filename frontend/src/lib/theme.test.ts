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

  // Settings chooses; the other screens read the colour in effect. Both must see the same value
  it("paints the document and remembers the choice", () => {
    chooseTheme("dark");

    expect(theme()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("theme")).toBe("dark");
  });

  // system resolves to "the device's current colour", but what is remembered stays system
  it("keeps system as system while resolving it for the document", () => {
    chooseTheme("system");

    expect(theme()).toBe("system");
    expect(localStorage.getItem("theme")).toBe("system");
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
