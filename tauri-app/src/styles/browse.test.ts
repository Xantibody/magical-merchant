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
 * 絞る画面を殻ごと立てる。`.app` は窓の高さに縛られていて `overflow: hidden`
 * なので、中で伸びたものの行き先はどこにも無い — そこが要点。
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
   * チップの帯はタグの数だけ縦に伸びる。伸びきると結果の列の高さが 0 になり、
   * `.app` が刈るので送って辿りつくこともできない。帯自身の高さを切って、
   * 溢れるぶんは帯の中で送る
   */
  it("keeps the results reachable however many tags the corpus has", async () => {
    await page.viewport(390, 800);
    mountBrowse(60);

    const facets = element(".browse-facets").getBoundingClientRect();
    const results = element(".browse-results").getBoundingClientRect();

    // 帯は画面の 38% まで。残りは結果のもの
    expect(facets.height).toBeLessThanOrEqual(0.38 * 800 + 1);
    expect(results.height).toBeGreaterThan(200);
    expect(results.bottom).toBeLessThanOrEqual(801);
  });

  it("sends the overflowing chips inside the strip, not off the screen", async () => {
    await page.viewport(390, 800);
    mountBrowse(60);

    const facets = element(".browse-facets");

    expect(getComputedStyle(facets).overflowY).toBe("auto");
    // 送れるものが実際にある。切った高さより中身のほうが高い
    expect(facets.scrollHeight).toBeGreaterThan(facets.clientHeight);
  });

  // タグが少ないうちは切る必要が無い。帯は中身ぶんの高さで止まる
  it("takes only the height it needs when there are few tags", async () => {
    await page.viewport(390, 800);
    mountBrowse(3);

    const facets = element(".browse-facets");

    expect(facets.getBoundingClientRect().height).toBeLessThan(0.38 * 800);
    expect(facets.scrollHeight).toBeLessThanOrEqual(facets.clientHeight + 1);
  });
});
