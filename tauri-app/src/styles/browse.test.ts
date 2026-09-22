import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { page } from "vitest/browser";

function element(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) {
    throw new Error(`expected ${selector} to be mounted`);
  }
  return found;
}

function chips(count: number): string {
  return Array.from(
    { length: count },
    (_, i) =>
      `<button class="browse-chip" type="button">tag-${i}<span class="browse-chip-count">3</span></button>`,
  ).join("");
}

/**
 * Stands the Browse screen up with its shell. `.app` is bound to the window height and is
 * `overflow: hidden`, so whatever grows inside it has nowhere to go. That is the point.
 */
function mountBrowse(tagCount: number): void {
  document.body.innerHTML = `
    <div class="app">
      <div class="app-column">
        <main class="app-main">
          <div class="browse">
            <aside class="browse-facets" aria-label="絞る">
              <h1 class="browse-title">絞る</h1>
              <div class="browse-group" role="group" aria-label="種類">${chips(3)}</div>
              <div class="browse-group browse-group--tags" role="group" aria-label="タグ">
                ${chips(tagCount)}
              </div>
              <div class="browse-group" role="group" aria-label="期間">${chips(4)}</div>
            </aside>
            <div class="browse-results">
              <div class="browse-list">
                <div class="browse-list-head"></div>
                ${Array.from({ length: 20 }, () => `<button class="browse-row">記録</button>`).join("")}
              </div>
              <div class="browse-preview"></div>
            </div>
          </div>
        </main>
      </div>
    </div>`;
}

describe("the browse screen on a phone", () => {
  beforeAll(async () => {
    await import("../index.css");
    await import("./browse.css");
  });

  afterEach(async () => {
    document.body.innerHTML = "";
    await page.viewport(1280, 800);
  });

  /**
   * The chip strip grows taller with the number of tags. Grown out, it leaves the results column
   * a height of 0, and `.app` clips it, so scrolling cannot reach it either. Cap the strip's own
   * height and scroll the overflow inside the strip
   */
  it("keeps the results reachable however many tags the corpus has", async () => {
    await page.viewport(390, 800);
    mountBrowse(60);

    const facets = element(".browse-facets").getBoundingClientRect();
    const results = element(".browse-results").getBoundingClientRect();

    // The strip takes at most 38% of the screen. The rest belongs to the results
    expect(facets.height).toBeLessThanOrEqual(0.38 * 800 + 1);
    expect(results.height).toBeGreaterThan(200);
    expect(results.bottom).toBeLessThanOrEqual(801);
  });

  it("sends the overflowing chips inside the strip, not off the screen", async () => {
    await page.viewport(390, 800);
    mountBrowse(60);

    const facets = element(".browse-facets");

    expect(getComputedStyle(facets).overflowY).toBe("auto");
    // There really is something to scroll: the content is taller than the capped height
    expect(facets.scrollHeight).toBeGreaterThan(facets.clientHeight);
  });

  // While there are few tags there is nothing to cap. The strip stops at the height of its content
  it("takes only the height it needs when there are few tags", async () => {
    await page.viewport(390, 800);
    mountBrowse(3);

    const facets = element(".browse-facets");

    expect(facets.getBoundingClientRect().height).toBeLessThan(0.38 * 800);
    expect(facets.scrollHeight).toBeLessThanOrEqual(facets.clientHeight + 1);
  });
});
