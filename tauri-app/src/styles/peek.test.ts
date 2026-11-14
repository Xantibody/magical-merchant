import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { page } from "vitest/browser";

/**
 * While a finger slides a level away (60, 61), what it goes back to must be drawn under it: the
 * list under a note or a template, the list of pages under a Settings page. The classes are the
 * ones the screens put on while the stroke lasts (Workspace's and Templates' `workspace--peek`,
 * Settings' `settings--peek`); the page itself is what the finger moves. A rule that leaves the
 * under-pane `display: none` showed an empty dark gap for the whole slide.
 */

const NOTE_OVER_LIST = `
  <div class="app">
    <div class="app-column">
      <main class="app-main">
        <div class="workspace workspace--detail workspace--peek">
          <div class="list-pane">
            <div class="list-scroll">
              <button class="list-row"><span class="list-row-title">短いメモ</span></button>
            </div>
          </div>
          <div class="detail-pane palm-lifted" style="animation: none; transform: translateX(130px)">
            <div class="detail-panes"><div class="detail-body"><p>本文</p></div></div>
          </div>
        </div>
      </main>
    </div>
  </div>`;

const PAGE_OVER_PAGES = `
  <div class="app">
    <div class="app-column">
      <main class="app-main">
        <div class="settings settings--page settings--peek">
          <nav class="settings-nav">
            <button class="settings-nav-row">一般</button>
          </nav>
          <div class="settings-page palm-lifted" style="animation: none; transform: translateX(130px)">
            <div class="settings-page-inner"><h2 class="settings-page-title">一般</h2></div>
          </div>
        </div>
      </main>
    </div>
  </div>`;

const TEMPLATE_LEFT = `
  <div class="app">
    <div class="app-column">
      <main class="app-main">
        <div class="workspace templates">
          <div class="list-pane">
            <div class="list-scroll"><button class="list-row">meeting</button></div>
            <button class="compose-fab templates-fab"></button>
          </div>
          <div class="detail-pane">
            <div class="detail-meta-bar"><button class="detail-back"></button></div>
            <div class="templates-tabs"><button class="templates-tab">編集</button></div>
            <div class="templates-columns">
              <div class="templates-edit"><label class="templates-label">本文</label></div>
            </div>
          </div>
        </div>
      </main>
    </div>
  </div>`;

function box(selector: string): DOMRect {
  const found = document.querySelector(selector);
  if (!found) {
    throw new Error(`expected ${selector} to be mounted`);
  }
  return found.getBoundingClientRect();
}

describe("the level under a page being slid away", () => {
  beforeAll(async () => {
    await import("../index.css");
    await import("./workspace.css");
    await import("./settings.css");
    await page.viewport(390, 844);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("draws the list under a note, across the screen", () => {
    document.body.innerHTML = NOTE_OVER_LIST;
    const list = box(".list-pane");

    expect(list.width).toBe(390);
    expect(list.height).toBeGreaterThan(400);
    // Seen in the gap the note leaves on its left
    expect(document.elementFromPoint(40, 300)?.closest(".list-pane")).not.toBeNull();
  });

  it("draws the list of pages under a Settings page", () => {
    document.body.innerHTML = PAGE_OVER_PAGES;

    expect(box(".settings-nav").width).toBeGreaterThan(300);
    expect(document.elementFromPoint(40, 100)?.closest(".settings-nav")).not.toBeNull();
  });

  it("keeps the list away once the slide has ended", () => {
    document.body.innerHTML = NOTE_OVER_LIST.replace(" workspace--peek", "");

    expect(box(".list-pane").width).toBe(0);
  });

  // Back from a template (its ← or the slide) closes the level, not the template: what was open
  // stays chosen, so the editor is still mounted beside the list and must lie nowhere on it
  it("leaves nothing of the editor under the template list once it is left", () => {
    document.body.innerHTML = TEMPLATE_LEFT;

    expect(box(".detail-pane").height).toBe(0);
    expect(box(".list-pane").height).toBeGreaterThan(800);
    // The + stands at the foot again, not halfway up over a shortened list
    expect(box(".templates-fab").bottom).toBeGreaterThan(844 - 40);
  });
});
