import { describe, it, expect, beforeAll, afterEach } from "vitest";

/**
 * The capture bar floats over Scrawl. If the scroll area's bottom padding is thinner than
 * the bar, the bottom entry stays hidden even when scrolled all the way down. By eye this
 * is usually noticed only when the entry just written cannot be read, which is too late.
 */
function mountScrawl(entries: number): void {
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
        <div class="scrawl">
          <div class="scrawl-scroll">
            <div class="scrawl-column">
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

describe("scrawl under the floating capture bar", () => {
  beforeAll(async () => {
    await import("../index.css");
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("lets the last entry scroll clear of the capture bar", () => {
    mountScrawl(60);
    const scroll = element(".scrawl-scroll");
    scroll.scrollTop = scroll.scrollHeight;

    const lastEntry = [...document.querySelectorAll<HTMLElement>(".entry")].at(-1);
    const dockTop = element(".capture-dock").getBoundingClientRect().top;

    expect(lastEntry?.getBoundingClientRect().bottom).toBeLessThanOrEqual(dockTop);
  });

  it("keeps the capture bar inside the scrawl", () => {
    mountScrawl(3);

    const scrawl = element(".scrawl").getBoundingClientRect();
    const dock = element(".capture-dock").getBoundingClientRect();

    expect(dock.bottom).toBeLessThanOrEqual(scrawl.bottom + 0.5);
    expect(dock.top).toBeGreaterThanOrEqual(scrawl.top);
  });

  // Short body or long, the three columns of time, rail and body stay aligned
  it("lines the entries up on one rail", () => {
    mountScrawl(3);
    const rails = [...document.querySelectorAll<HTMLElement>(".entry-rail-dot")].map(
      (dot) => dot.getBoundingClientRect().left,
    );

    expect(new Set(rails).size).toBe(1);
  });
});

/** Lay out the tag row, digest, day heading and promotion link so the separations show. */
function mountChrome(): void {
  document.body.innerHTML = `
    <div class="scrawl">
      <div class="scrawl-scroll">
        <div class="scrawl-column">
          <div class="scrawl-head">
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

/** The height limit for one line. Text at 12.5px on two lines always exceeds it. */
const ONE_LINE = 24;

const TRANSPARENT = "rgba(0, 0, 0, 0)";

describe("scrawl chrome", () => {
  beforeAll(async () => {
    await import("../index.css");
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  // Giving the weekly summary a border and a ground adds one more box on top of the reading
  it("prints the weekly digest as a line, not a card", () => {
    mountChrome();
    const digest = element(".digest-line");

    const style = getComputedStyle(digest);

    expect(style.backgroundColor).toBe(TRANSPARENT);
    expect(style.borderTopWidth).toBe("0px");
    expect(digest.getBoundingClientRect().height).toBeLessThanOrEqual(ONE_LINE);
  });

  // A rule where heading size and spacing already suffice doubles the signal for a break
  it("separates one day from the next with space alone", () => {
    mountChrome();
    const second = element(".day-group + .day-group .day-heading");

    expect(getComputedStyle(second).borderTopWidth).toBe("0px");
  });

  // Nothing is filtered here, so no chip is filled. Each stands on its border alone
  it("leaves the tag chips as outlines", () => {
    mountChrome();

    expect(getComputedStyle(element(".tag-chip")).backgroundColor).toBe(TRANSPARENT);
  });

  // A promoted note is one more line of the body. A rounded border makes it an island of controls
  it("hangs the promoted note under the entry as a plain line", () => {
    mountChrome();
    const chip = element(".origin-chip");

    const style = getComputedStyle(chip);

    expect(style.backgroundColor).toBe(TRANSPARENT);
    expect(style.borderTopWidth).toBe("0px");
  });
});
