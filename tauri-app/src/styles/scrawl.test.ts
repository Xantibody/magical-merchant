import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { page } from "vitest/browser";

/**
 * The delete bar floats over Scrawl while selecting. If the scroll area's bottom padding is
 * thinner than the bar, the bottom entry cannot be reached to be selected at all.
 */
function mountScrawl(entries: number): void {
  const rows = Array.from(
    { length: entries },
    (_, i) => `
      <article class="swipe-row"><div class="entry swipe-face">
        <span class="entry-time">0${i}:00</span>
        <span class="entry-rail"><span class="entry-rail-line"></span><span class="entry-rail-dot"></span></span>
        <div class="entry-body"><p class="entry-text">エントリ ${i}</p></div>
      </div></article>`,
  ).join("");

  document.body.innerHTML = `
    <div class="app">
      <main class="app-main">
        <div class="scrawl scrawl--selecting">
          <div class="scrawl-scroll">
            <div class="scrawl-column">
              <section class="day-group" data-day="2026-08-05">
                <header class="day-heading"><h2 class="day-heading-label">今日</h2></header>
                ${rows}
              </section>
            </div>
          </div>
          <div class="capture-dock">
            <div class="select-bar"><span class="select-bar-label">2 件</span></div>
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

describe("scrawl under the floating delete bar", () => {
  beforeAll(async () => {
    await import("../index.css");
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("lets the last entry scroll clear of the delete bar", () => {
    mountScrawl(60);
    const scroll = element(".scrawl-scroll");
    scroll.scrollTop = scroll.scrollHeight;

    const lastEntry = [...document.querySelectorAll<HTMLElement>(".entry")].at(-1);
    const dockTop = element(".capture-dock").getBoundingClientRect().top;

    expect(lastEntry?.getBoundingClientRect().bottom).toBeLessThanOrEqual(dockTop);
  });

  it("keeps the delete bar inside the scrawl", () => {
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

describe("scrawl record text", () => {
  beforeAll(async () => {
    await import("../index.css");
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  // The long press that turns selection off is a finger's gesture, and `lib/long-press.ts`
  // ignores the mouse. With a mouse the record could be neither dragged over nor copied,
  // and ⌘A skipped every record on the page
  it("lets a mouse select a record's text", () => {
    document.body.innerHTML = `<p class="entry-text long-press">ベガのラッシュ止まらん</p>`;
    const mouse = globalThis.matchMedia("(hover: hover) and (pointer: fine)").matches;

    expect(mouse).toBe(true);
    expect(getComputedStyle(element(".entry-text")).userSelect).toBe("text");
  });
});

/**
 * Lay out the days with a promotion link, and under them the band of digest and tags, so
 * the separations show.
 */
function mountChrome(): void {
  document.body.innerHTML = `
    <div class="scrawl">
      <div class="scrawl-scroll">
        <div class="scrawl-column">
          <section class="day-group">
            <header class="day-heading"><h2 class="day-heading-label">今日</h2></header>
            <article class="swipe-row"><div class="entry swipe-face">
              <div class="entry-body">
                <p class="entry-text">ベガのラッシュ止まらん</p>
                <div class="entry-notes">
                  <span class="origin-chip">
                    <button class="origin-chip-open" type="button">SF6 ベガ対策メモ</button>
                  </span>
                </div>
              </div>
            </div></article>
          </section>
          <section class="day-group">
            <header class="day-heading"><h2 class="day-heading-label">昨日</h2></header>
          </section>
        </div>
      </div>
      <div class="scrawl-composer">
        <div class="scrawl-head">
          <div class="scrawl-band">
            <section class="digest-line">
              <span>4日で12件</span>
              <button class="digest-year-ago" type="button">1年前の今日</button>
              <button class="icon-button digest-close" type="button">x</button>
            </section>
            <div class="tag-filter">
              <div class="tag-filter-chips">
                <button class="tag-chip" type="button">#SF6</button>
                <button class="tag-chip" type="button">#CognitiveBias</button>
                <button class="tag-chip" type="button">#design</button>
                <button class="tag-chip" type="button">#perf</button>
                <button class="tag-chip" type="button">#sync</button>
                <button class="tag-chip" type="button">#fgc</button>
              </div>
            </div>
          </div>
          <button class="icon-button" type="button">cal</button>
        </div>
      </div>
    </div>`;
}

/** S4: the band is one row a chip high; a second line of chips or of digest would exceed it. */
const ONE_ROW = 44;

const TRANSPARENT = "rgba(0, 0, 0, 0)";

describe("scrawl chrome", () => {
  beforeAll(async () => {
    await import("../index.css");
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  // Giving the weekly summary a border and a ground adds one more box on top of the reading
  it("prints the weekly digest as words in the band, not a card", () => {
    mountChrome();
    const style = getComputedStyle(element(".digest-line"));

    expect(style.backgroundColor).toBe(TRANSPARENT);
    expect(style.borderTopWidth).toBe("0px");
  });

  // The week and the tags share one row and scroll sideways instead of wrapping
  it("keeps the week and the tags to one sideways-scrolling row", () => {
    mountChrome();
    const band = element(".scrawl-band");
    band.style.maxWidth = "240px";

    expect(element(".scrawl-head").getBoundingClientRect().height).toBeLessThanOrEqual(ONE_ROW);
    expect(band.scrollWidth).toBeGreaterThan(band.clientWidth);
    expect(getComputedStyle(band).overflowX).toBe("auto");
  });

  // S5: the day in view stays readable while its records scroll under it
  it("sticks the day heading to the top edge of the scroll area", () => {
    mountChrome();
    const scroll = element(".scrawl-scroll");
    scroll.style.flex = "none";
    scroll.style.height = "120px";
    const today = element(".day-group .entry");
    today.style.height = "600px";

    scroll.scrollTop = 300;

    const heading = element(".day-group .day-heading").getBoundingClientRect();
    expect(heading.top).toBeCloseTo(scroll.getBoundingClientRect().top, 0);
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

/** One entry with its hidden promote button, as ScrawlEntry draws it. */
function mountEntry(): void {
  document.body.innerHTML = `
    <article class="swipe-row"><div class="entry swipe-face">
      <div class="entry-body">
        <p class="entry-text">ベガのラッシュ止まらん</p>
        <div class="entry-actions">
          <button class="icon-button entry-action" type="button">Note にする</button>
        </div>
      </div>
    </div></article>`;
}

/**
 * The `display` the stylesheets give `target` inside `@media <condition>`, read off the CSSOM.
 *
 * AIDEV-NOTE: not an emulated phone. On the CI's Linux Chromium, turning
 * Emulation.setTouchEmulationEnabled off left `(hover: none)` matching, so every later test
 * in the page ran without hover; Emulation.setEmulatedMedia has no `hover` feature at all.
 */
function displayUnder(condition: string, target: Element): string | undefined {
  const rules: CSSRule[] = [];
  for (const sheet of document.styleSheets) {
    for (const rule of sheet.cssRules) {
      if (rule instanceof CSSMediaRule && rule.conditionText === condition) {
        rules.push(...rule.cssRules);
      }
    }
  }
  const own = rules.find(
    (rule): rule is CSSStyleRule =>
      rule instanceof CSSStyleRule && target.matches(rule.selectorText),
  );
  return own?.style.display;
}

describe("the promote button on an entry", () => {
  beforeAll(async () => {
    await import("../index.css");
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  // Hidden by opacity alone it still took a tap at the entry's top right and opened the
  // promote dialog. A long press is the way in on touch
  it("is not there to tap on a screen without hover", () => {
    mountEntry();

    expect(displayUnder("(hover: none)", element(".entry-actions"))).toBe("none");
  });

  // The way in on desktop, shown on hover and on keyboard focus
  it("stays in the layout where there is hover", () => {
    mountEntry();

    expect(matchMedia("(hover: hover)").matches).toBe(true);
    expect(getComputedStyle(element(".entry-actions")).display).not.toBe("none");
  });
});

/**
 * A phone's Scrawl: the list, then the shell's place pill stretched over its foot with the
 * field carried into its slot, as AppLayout and Scrawl draw them together.
 */
function mountDock(entries: number, newest = false): void {
  const rows = Array.from(
    { length: entries },
    (_, i) =>
      `<article class="swipe-row"><div class="entry swipe-face"><div class="entry-body"><p class="entry-text">エントリ ${i}</p></div></div></article>`,
  ).join("");
  document.body.innerHTML = `
    <div class="app">
      <div class="app-column">
        <main class="app-main">
          <div class="app-route">
            <div class="scrawl">
              <div class="scrawl-scroll"><div class="scrawl-column">${rows}</div></div>
            </div>
            <div class="place-switch place-switch--stretched">
              <span class="place-switch-ground"></span>
              <nav class="place-switch-places">
                <button class="place-switch-button">S</button>
                <button class="place-switch-button">N</button>
                <button class="place-switch-button">C</button>
              </nav>
              <div class="place-switch-slot">
                <div class="scrawl-dock">
                  ${newest ? `<button class="scrawl-newest">↑</button>` : ""}
                  <div class="capture-bar">
                    <textarea class="capture-input" rows="1" placeholder="いま何を記録する？"></textarea>
                    <button class="capture-send">送</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>`;
}

describe("Scrawl's field in the place pill on a phone", () => {
  beforeAll(async () => {
    await import("../index.css");
    await page.viewport(390, 844);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  afterAll(async () => {
    await page.viewport(1280, 800);
  });

  // The same pill as on a list, the same height: stretching it must not make it a taller bar
  it("keeps the resting pill at the list's pill height", () => {
    mountDock(3);

    expect(element(".place-switch").getBoundingClientRect().height).toBe(56);
  });

  // Floating with a gutter on both sides, not a bar running edge to edge
  it("stretches between the gutters and floats over the foot", () => {
    mountDock(3);
    const pill = element(".place-switch").getBoundingClientRect();
    const main = element(".app-main").getBoundingClientRect();

    expect(pill.left).toBe(16);
    expect(pill.right).toBe(390 - 16);
    expect(main.bottom - pill.bottom).toBe(16);
    expect(getComputedStyle(element(".place-switch")).borderTopWidth).toBe("0px");
  });

  it("sits the places and the field side by side without overlap", () => {
    mountDock(3);
    const places = element(".place-switch-places").getBoundingClientRect();
    const field = element(".capture-bar").getBoundingClientRect();
    const pill = element(".place-switch").getBoundingClientRect();

    expect(places.right).toBeLessThanOrEqual(field.left);
    expect(field.right).toBeLessThanOrEqual(pill.right);
    expect(element(".capture-send").getBoundingClientRect().right).toBeLessThanOrEqual(pill.right);
  });

  // A wrapped question would make the resting field two lines tall beside the places
  it("keeps the field's question on one line at rest", () => {
    mountDock(3);
    const input = element(".capture-input") as HTMLTextAreaElement;
    input.placeholder = "What's on your mind? And a few more words to be sure";

    expect(input.getBoundingClientRect().height).toBeCloseTo(
      Number.parseFloat(getComputedStyle(input).lineHeight),
      0,
    );
  });

  // While writing, the field has the whole row; the places come back once it lets go
  it("gives the field the whole row while it has the focus", () => {
    mountDock(3);

    element(".capture-input").focus();
    const places = getComputedStyle(element(".place-switch-places"));

    expect(places.pointerEvents).toBe("none");
    expect(places.position).toBe("absolute");
    expect(element(".capture-bar").getBoundingClientRect().width).toBeGreaterThan(340);
  });

  // They step aside by fading and sliding, the two things the motion rule lets move
  it("moves the places aside by opacity and transform alone", () => {
    mountDock(3);

    element(".capture-input").focus();
    const moved = element(".place-switch-places")
      .getAnimations()
      .map((animation) => (animation as CSSTransition).transitionProperty)
      .toSorted();

    expect(moved).toStrictEqual(["opacity", "transform", "visibility"]);
  });

  // Only the field: a focused button in the pill leaves the places where they are
  it("keeps the places when a pill button has the focus", () => {
    mountDock(3);

    element(".place-switch-button").focus();

    expect(getComputedStyle(element(".place-switch-places")).pointerEvents).not.toBe("none");
    expect(element(".capture-bar").getBoundingClientRect().width).toBeLessThan(340);
  });

  // The pill floats, so the list keeps room under its last record for it
  it("leaves no record under the pill", () => {
    mountDock(60);
    const scroll = element(".scrawl-scroll");
    scroll.scrollTop = scroll.scrollHeight;

    const last = [...document.querySelectorAll<HTMLElement>(".entry")].at(-1);

    expect(last?.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      element(".place-switch").getBoundingClientRect().top,
    );
  });

  // The way back to the newest rides above the pill's right end, and up with a grown field
  it("hangs the way back to the newest above the pill", () => {
    mountDock(3, true);
    const pill = element(".place-switch");
    const input = element(".capture-input") as HTMLTextAreaElement;
    input.value = "1\n2\n3\n4";

    const newest = element(".scrawl-newest").getBoundingClientRect();

    expect(newest.bottom).toBeLessThanOrEqual(pill.getBoundingClientRect().top);
    expect(newest.right).toBe(pill.getBoundingClientRect().right);
    expect(newest.height).toBeGreaterThanOrEqual(44);
  });

  // Where the keyboard leaves the page its height, the pill rides on top of it
  it("lifts the pill over the keyboard by the inset it is handed", () => {
    mountDock(3);
    const pill = element(".place-switch");
    const resting = pill.getBoundingClientRect().bottom;

    pill.style.setProperty("--keyboard-lift", "300px");

    expect(resting - pill.getBoundingClientRect().bottom).toBe(300);
  });
});
