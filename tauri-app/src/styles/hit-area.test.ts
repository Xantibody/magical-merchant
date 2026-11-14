import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { page } from "vitest/browser";

/**
 * A finger needs 44px. On a phone the status dot in the corner is 20px, the select link
 * 18px, the weekly digest's × 32px, and the chips 34px. They keep the size
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

/** No bar on top: the state's dot alone in the corner. */
const PALM = `
  <div class="palm-dot">
    <button class="status-dot" aria-label="保存と同期"><span class="status-dot-mark"></span></button>
  </div>`;

/** The app's frame around one screen, as AppLayout draws it on a phone. */
function shell(screen: string): string {
  return `
    <div class="app">
      <div class="app-column">
        <main class="app-main">${screen}${PALM}</main>
      </div>
    </div>`;
}

/** The page's name and today at the top; the band ends the sheet, over the pill. */
const SCRAWL = shell(`
  <div class="scrawl">
    <div class="scrawl-scroll">
      <div class="scrawl-column">
        <h1 class="list-big-title scrawl-big-title">Scrawl<span class="list-big-count">5日で41件</span></h1>
        <section class="day-group day-group--current">
          <header class="day-heading">
            <h2 class="day-heading-label">今日</h2>
            <span class="day-heading-date">11月8日 日曜日</span>
            <span class="day-heading-count">4件<span>·</span><button class="day-heading-select">選択</button></span>
          </header>
        </section>
      </div>
    </div>
    <div class="scrawl-composer">
          <div class="scrawl-head">
            <div class="scrawl-band">
              <section class="digest-line">
                <button class="digest-year-ago">1年前の今日<span>→</span></button>
                <button class="icon-button digest-close" aria-label="今週は閉じる">
                  <span class="icon" style="display: inline-flex; width: 12px; height: 12px"></span>
                </button>
              </section>
              <div class="tag-filter">
                <div class="tag-filter-chips">
                  <button class="tag-chip">#perf</button>
                  <button class="tag-chip">#fgc</button>
                </div>
              </div>
            </div>
            <button class="icon-button" aria-label="日付へ">${ICON}</button>
          </div>
    </div>
  </div>
  <div class="place-switch place-switch--stretched">
    <span class="place-switch-ground"></span>
    <nav class="place-switch-places">
      <button class="place-switch-button" aria-label="Scrawl">${ICON}</button>
      <button class="place-switch-button" aria-label="Note">${ICON}</button>
      <button class="place-switch-button" aria-label="Codex">${ICON}</button>
    </nav>
    <div class="place-switch-slot">
      <div class="scrawl-dock">
        <div class="capture-bar">
          <textarea class="capture-input" rows="1" placeholder="いま何を記録する？"></textarea>
          <button class="capture-send" aria-label="記録する">${ICON}</button>
        </div>
      </div>
    </div>
  </div>`);

/** Scrawl read down: the bar folded to its line of words, the field to a pencil (4, 63). */
const SCRAWL_SLIM = shell(`
  <div class="scrawl">
    <div class="scrawl-scroll">
      <div class="scrawl-column"></div>
    </div>
  </div>
  <button class="palm-slim"><span class="status-dot-mark"></span><span class="palm-slim-place">Scrawl</span><span class="palm-slim-words">保存しました · すべて同期済み</span></button>
  <button class="compose-fab compose-fab--write" aria-label="書き留める">${ICON}</button>`);

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
      <button class="compose-fab" aria-label="Note を作る">${ICON}</button>
    </div>
  </div>`);

/** A note being read: the sheet's button and the pencil low on the right (63), no strip on top. */
const NOTE = shell(`
  <div class="workspace workspace--detail">
    <div class="detail-pane">
      <div class="note-strip">
        <span class="note-strip-fill"></span>
        <button class="icon-button" aria-label="マップ">${SMALL_ICON}</button>
      </div>
      <div class="palm-actions">
        <button class="palm-action-more" aria-label="この Note">${ICON}</button>
        <button class="compose-fab" aria-label="書く">${ICON}</button>
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
    ["the state's dot in the top corner", SCRAWL, ".palm-dot > *"],
    ["Scrawl's tag chips", SCRAWL, ".tag-chip"],
    ["the weekly digest", SCRAWL, ".digest-year-ago, .digest-close"],
    ["the select link on today's heading", SCRAWL, ".day-heading-select"],
    ["the places and the send button in Scrawl's place pill", SCRAWL, ".place-switch button"],
    ["the line of words the bar folds to", SCRAWL_SLIM, ".palm-slim"],
    ["the rows of the note list", NOTE_LIST, ".list-row"],
    ["the sheet's button over a note", NOTE, ".palm-action-more"],
    ["Browse's chips", BROWSE, ".browse-chip, .browse-clear"],
  ])("takes a tap anywhere within 44px of %s", (_place, html, selector) => {
    document.body.innerHTML = html;
    const controls = [...document.querySelectorAll(selector)];

    expect(controls.length).toBeGreaterThan(0);
    expect(controls.flatMap((control) => missedTaps(control))).toStrictEqual([]);
  });

  // The scrubber's tab sits on the right edge and reaches in only a little, at rest and while
  // the list moves alike;
  // a tap on the lines' last letters beside it stays the line's
  it.each([
    ["at rest", "scrubber"],
    ["while the list moves", "scrubber scrubber--awake"],
  ])("takes a tap within 28px in from the edge on the scrubber's tab %s", (_state, track) => {
    document.body.innerHTML = `
      <div style="position: relative; width: 390px; height: 844px">
        <div class="${track}"><button class="scrubber-thumb" style="top: 50%"></button></div>
      </div>`;
    const thumb = element(".scrubber-thumb");
    const box = thumb.getBoundingClientRect();
    const y = box.top + box.height / 2;

    expect(box.right).toBe(390);
    for (const x of [389, 376, 363]) {
      expect(thumb.contains(document.elementFromPoint(x, y))).toBe(true);
    }
    expect(thumb.contains(document.elementFromPoint(356, y))).toBe(false);
  });

  // The rule is about where a finger lands, not about drawing bigger chrome
  it.each([
    [".tag-chip", SCRAWL],
    [".browse-chip", BROWSE],
    [".palm-slim", SCRAWL_SLIM],
  ])("keeps %s drawn at its own size", (selector, html) => {
    document.body.innerHTML = html;

    expect(element(selector).getBoundingClientRect().height).toBeLessThan(44);
  });

  // Round, so the 44px around its middle reaches past its corners; it is drawn bigger instead
  it("draws the compose button on the note list at a thumb's size", () => {
    document.body.innerHTML = NOTE_LIST;
    const box = element(".compose-fab").getBoundingClientRect();

    expect(box.width).toBeGreaterThanOrEqual(56);
    expect(box.height).toBeGreaterThanOrEqual(56);
  });

  // The list's "+ new" gives way to the compose button low on the right (R2)
  it("leaves the list head's new-note button to the compose button", () => {
    document.body.innerHTML = NOTE_LIST;

    expect(getComputedStyle(element(".list-pane-actions .new-note")).display).toBe("none");
  });

  // A phone reads a note from the veil and the foot; the strip on top has nothing left to carry
  it("puts the strip over a note away on a phone", () => {
    document.body.innerHTML = NOTE;

    expect(getComputedStyle(element(".note-strip")).display).toBe("none");
  });
});
