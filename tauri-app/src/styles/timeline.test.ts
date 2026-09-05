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

/** タグ行・ダイジェスト・日見出し・昇格リンクを、区切りが見える形で並べる。 */
function mountChrome(): void {
  document.body.innerHTML = `
    <div class="timeline">
      <div class="timeline-scroll">
        <div class="timeline-column">
          <div class="timeline-head">
            <div class="tag-filter">
              <span class="tag-filter-label">TAGS</span>
              <div class="tag-filter-chips"><button class="tag-chip" type="button">#SF6</button></div>
            </div>
            <section class="digest-line">
              <span class="digest-label">今週</span><span>4日で12件</span>
              <span class="digest-sep">·</span>
              <button class="digest-year-ago" type="button">1年前の今日</button>
              <button class="icon-button digest-close" type="button">x</button>
            </section>
          </div>
          <section class="day-group">
            <header class="day-heading"><h2 class="day-heading-label">今日</h2></header>
            <article class="entry">
              <div class="entry-body">
                <p class="entry-text">ベガのラッシュ止まらん</p>
                <div class="entry-notes">
                  <span class="origin-chip">
                    <button class="origin-chip-open" type="button">SF6 ベガ対策メモ</button>
                  </span>
                </div>
              </div>
            </article>
          </section>
          <section class="day-group">
            <header class="day-heading"><h2 class="day-heading-label">昨日</h2></header>
          </section>
        </div>
      </div>
    </div>`;
}

/** 一行に収まる高さの上限。12.5px の字が 2 行になれば必ず超える。 */
const ONE_LINE = 24;

const TRANSPARENT = "rgba(0, 0, 0, 0)";

describe("timeline chrome", () => {
  beforeAll(async () => {
    await import("../index.css");
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  // 週の要約に枠と下地を与えると、読み物の上に箱が 1 つ増える
  it("prints the weekly digest as a line, not a card", () => {
    mountChrome();
    const digest = element(".digest-line");

    const style = getComputedStyle(digest);

    expect(style.backgroundColor).toBe(TRANSPARENT);
    expect(style.borderTopWidth).toBe("0px");
    expect(digest.getBoundingClientRect().height).toBeLessThanOrEqual(ONE_LINE);
  });

  // 見出しの大小と余白で足りるところに罫線を引くと、区切りの合図が二重になる
  it("separates one day from the next with space alone", () => {
    mountChrome();
    const second = element(".day-group + .day-group .day-heading");

    expect(getComputedStyle(second).borderTopWidth).toBe("0px");
  });

  // 塗ってあるのは絞り込み中のチップだけ。押していないチップは枠だけで立つ
  it("leaves the idle tag chips as outlines", () => {
    mountChrome();

    expect(getComputedStyle(element(".tag-chip")).backgroundColor).toBe(TRANSPARENT);
  });

  // 昇格ノートは本文の続きの 1 行。丸い枠を付けると押し物の島になる
  it("hangs the promoted note under the entry as a plain line", () => {
    mountChrome();
    const chip = element(".origin-chip");

    const style = getComputedStyle(chip);

    expect(style.backgroundColor).toBe(TRANSPARENT);
    expect(style.borderTopWidth).toBe("0px");
  });
});
