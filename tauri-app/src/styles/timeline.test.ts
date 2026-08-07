import { describe, it, expect, beforeAll, afterEach } from "vitest";

/**
 * 入力バーはタイムラインの上に浮いている。スクロール領域の下 padding が
 * バーより薄いと、一番下のエントリが最後までスクロールしても隠れたままになる。
 * 目で見て気づくのはたいてい書いた直後の一件が読めないときで、遅い。
 */
function mountTimeline(entries: number): void {
  const rows = Array.from(
    { length: entries },
    (_, i) => `
      <article class="entry">
        <span class="entry-time">0${i}:00</span>
        <span class="entry-rail"><span class="entry-rail-line"></span><span class="entry-rail-dot"></span></span>
        <div class="entry-body"><p class="entry-text">エントリ ${i}</p></div>
      </article>`,
  ).join("");

  document.body.innerHTML = `
    <div class="app">
      <header class="header">header</header>
      <main class="app-main">
        <div class="timeline">
          <div class="timeline-scroll">
            <div class="timeline-column">
              <section class="day-group" data-day="2026-08-05">
                <header class="day-heading"><h2 class="day-heading-label">今日</h2></header>
                ${rows}
              </section>
            </div>
          </div>
          <div class="capture-dock">
            <div class="capture-bar">
              <textarea class="capture-input"></textarea>
              <button class="capture-send" type="button">送信</button>
            </div>
          </div>
        </div>
      </main>
    </div>`;
}

function element(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) {
    throw new Error(`expected ${selector} to be mounted`);
  }
  return found;
}

describe("timeline under the floating capture bar", () => {
  beforeAll(async () => {
    await import("../index.css");
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("lets the last entry scroll clear of the capture bar", () => {
    mountTimeline(60);
    const scroll = element(".timeline-scroll");
    scroll.scrollTop = scroll.scrollHeight;

    const lastEntry = [...document.querySelectorAll<HTMLElement>(".entry")].at(-1);
    const dockTop = element(".capture-dock").getBoundingClientRect().top;

    expect(lastEntry?.getBoundingClientRect().bottom).toBeLessThanOrEqual(dockTop);
  });

  it("keeps the capture bar inside the timeline", () => {
    mountTimeline(3);

    const timeline = element(".timeline").getBoundingClientRect();
    const dock = element(".capture-dock").getBoundingClientRect();

    expect(dock.bottom).toBeLessThanOrEqual(timeline.bottom + 0.5);
    expect(dock.top).toBeGreaterThanOrEqual(timeline.top);
  });

  // 本文が短くても長くても、時刻とレールと本文の 3 列がずれない
  it("lines the entries up on one rail", () => {
    mountTimeline(3);
    const rails = [...document.querySelectorAll<HTMLElement>(".entry-rail-dot")].map(
      (dot) => dot.getBoundingClientRect().left,
    );

    expect(new Set(rails).size).toBe(1);
  });
});
