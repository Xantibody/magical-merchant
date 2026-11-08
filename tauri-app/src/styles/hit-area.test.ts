import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { page } from "vitest/browser";

/**
 * A finger needs 44px. On a phone the header's icons were 38px, the note strip's 30px, the
 * new-note button 26px tall, the select link 18px, the weekly digest's × 16px, and the chips
 * 34px. They keep the size
 * they are drawn at; what grows is where a tap lands. So this taps around each control, the
 * way a thumb lands a little off, and asks what was hit: that also catches a hit area cut off
 * by a scrolling row, or covered by the next control's.
 */

/** The last whole pixel inside 44px on each side. Hit testing goes by pixel, so a point on a
 * half pixel is rounded onto whichever box starts there. */
const REACH = 21;

const DIRECTIONS = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

function element(selector: string): Element {
  const found = document.querySelector(selector);
  if (!found) {
    throw new Error(`expected ${selector} to be mounted`);
  }
  return found;
}

function label(node: Element | null): string {
  return node ? `${node.tagName.toLowerCase()}.${[...node.classList].join(".")}` : "nothing";
}

/** The taps 21.5px off the control's middle that land on something else. */
function missedTaps(control: Element): string[] {
  const box = control.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  return DIRECTIONS.map(([dx = 0, dy = 0]) => ({
    dx,
    dy,
    hit: document.elementFromPoint(x + dx * REACH, y + dy * REACH),
  }))
    .filter(({ hit }) => !control.contains(hit))
    .map(
      ({ dx, dy, hit }) =>
        `${label(control)} "${control.textContent?.trim()}" ${dx},${dy}: ${label(hit)}`,
    );
}

const ICON = `<span class="icon" style="display: inline-flex; width: 18px; height: 18px"></span>`;

/** The strip's map and pencil are a pixel smaller than its other icons. */
const SMALL_ICON = `<span class="icon" style="display: inline-flex; width: 17px; height: 17px"></span>`;

const HEADER = `
  <header class="mobile-header">
    <span class="mobile-header-title">Scrawl</span>
    <div class="mobile-header-actions">
      <button class="icon-button" aria-label="日付ジャンプ">${ICON}</button>
      <button class="icon-button" aria-label="検索">${ICON}</button>
      <button class="status-dot" aria-label="保存と同期"><span class="status-dot-mark"></span></button>
    </div>
  </header>`;

/** The app's frame around one screen, as AppLayout draws it on a phone. */
function shell(screen: string): string {
  return `
    <div class="app">
      <div class="app-column">
        ${HEADER}
        <main class="app-main">${screen}</main>
      </div>
    </div>`;
}

const SCRAWL = shell(`
  <div class="scrawl">
    <div class="scrawl-scroll">
      <div class="scrawl-column">
        <div class="scrawl-head">
          <div class="scrawl-head-row">
            <div class="tag-filter">
              <span class="tag-filter-label">TAGS</span>
              <div class="tag-filter-chips">
                <button class="tag-chip">#perf</button>
                <button class="tag-chip">#sync</button>
                <button class="tag-chip">#fgc</button>
              </div>
            </div>
          </div>
          <section class="digest-line">
            <span class="digest-label">今週</span>
            <span>7日で41件</span>
            <span class="digest-sep">·</span>
            <button class="digest-year-ago">1年前の今日<span>→</span></button>
            <button class="icon-button digest-close" aria-label="今週は閉じる">
              <span class="icon" style="display: inline-flex; width: 12px; height: 12px"></span>
            </button>
          </section>
        </div>
        <section class="day-group">
          <header class="day-heading">
            <h2 class="day-heading-label">今日</h2>
            <span class="day-heading-date">11月8日 日曜日</span>
            <span class="day-heading-count">4件<span>·</span><button class="day-heading-select">選択</button></span>
          </header>
          <div class="entry entry--input">
            <span class="entry-time"></span>
            <span class="entry-rail"><span class="entry-rail-dot"></span></span>
            <div class="entry-body">
              <div class="capture-bar"><textarea rows="1" class="capture-input"></textarea></div>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>`);

const NOTE_LIST = shell(`
  <div class="workspace">
    <div class="list-pane">
      <div class="list-pane-head">
        <span class="list-pane-title">Note</span>
        <div class="list-pane-actions">
          <button class="new-note"><span class="icon" style="display: inline-flex; width: 12px; height: 12px"></span>新規</button>
        </div>
      </div>
      <div class="list-scroll">
        <div class="list-group-label">それ以前</div>
        <button class="list-row"><span class="list-row-title">短いメモ</span></button>
      </div>
    </div>
  </div>`);

const NOTE = shell(`
  <div class="workspace workspace--detail">
    <div class="detail-pane">
      <div class="note-strip">
        <button class="icon-button detail-back" aria-label="一覧に戻る">${ICON}</button>
        <span class="note-strip-fill"></span>
        <button class="icon-button" aria-label="マップ">${SMALL_ICON}</button>
        <button class="icon-button" aria-label="書く">${SMALL_ICON}</button>
        <button class="icon-button note-panel-toggle" aria-label="この Note">${ICON}</button>
      </div>
    </div>
  </div>`);

const BROWSE = shell(`
  <div class="browse">
    <aside class="browse-facets">
      <h1 class="browse-title">絞る</h1>
      <div class="browse-group">
        <span class="browse-group-label">種類</span>
        <button class="browse-chip">Codex<span class="browse-chip-count">2</span></button>
        <button class="browse-chip">Note<span class="browse-chip-count">5</span></button>
        <button class="browse-chip">Scrawl<span class="browse-chip-count">122</span></button>
      </div>
      <div class="browse-group browse-group--tags">
        <span class="browse-group-label">タグ</span>
        <button class="browse-chip">#design<span class="browse-chip-count">15</span></button>
        <button class="browse-chip">#perf<span class="browse-chip-count">15</span></button>
        <button class="browse-chip">#fgc<span class="browse-chip-count">14</span></button>
        <button class="browse-chip">#CognitiveBias<span class="browse-chip-count">13</span></button>
        <button class="browse-chip">#sync<span class="browse-chip-count">13</span></button>
      </div>
      <div class="browse-group">
        <span class="browse-group-label">期間</span>
        <button class="browse-chip" aria-pressed="true">すべて</button>
        <button class="browse-chip">今月</button>
        <button class="browse-chip">今週</button>
      </div>
      <button class="browse-clear">クリア</button>
    </aside>
  </div>`);

describe("the small controls on a phone", () => {
  beforeAll(async () => {
    await import("../index.css");
    await import("./workspace.css");
    await import("./browse.css");
    await page.viewport(390, 844);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it.each([
    ["the header's icons", SCRAWL, ".mobile-header-actions > *"],
    ["Scrawl's tag chips", SCRAWL, ".tag-chip"],
    ["the weekly digest", SCRAWL, ".digest-year-ago, .digest-close"],
    ["the select link on today's heading", SCRAWL, ".day-heading-select"],
    ["the new-note button over the note list", NOTE_LIST, ".new-note"],
    ["the strip over a note", NOTE, ".note-strip .icon-button"],
    ["Browse's chips", BROWSE, ".browse-chip, .browse-clear"],
  ])("takes a tap anywhere within 44px of %s", (_place, html, selector) => {
    document.body.innerHTML = html;
    const controls = [...document.querySelectorAll(selector)];

    expect(controls.length).toBeGreaterThan(0);
    expect(controls.flatMap((control) => missedTaps(control))).toStrictEqual([]);
  });

  // The rule is about where a finger lands, not about drawing bigger chrome
  it.each([
    [".tag-chip", SCRAWL],
    [".browse-chip", BROWSE],
    [".note-strip .icon-button", NOTE],
  ])("keeps %s drawn at its own size", (selector, html) => {
    document.body.innerHTML = html;

    expect(element(selector).getBoundingClientRect().height).toBeLessThan(44);
  });

  // A tap meant for the input line must not open select mode
  it("leaves the input line under today's heading to the input", () => {
    document.body.innerHTML = SCRAWL;
    const input = element(".capture-input");
    const box = input.getBoundingClientRect();

    expect(document.elementFromPoint(box.right - 4, box.top + 1)).toBe(input);
  });
});
