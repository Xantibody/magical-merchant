import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { page } from "vitest/browser";

/**
 * A wide window's linked note (88) lies where the note panel lies and the body yields the room:
 * a card standing over the text hid the lines next to the one being read, wherever it was put.
 */

const NOTE_WITH_PEEK = `
  <div class="app">
    <div class="app-column">
      <main class="app-main">
        <div class="workspace">
          <div class="list-pane"><div class="list-scroll"></div></div>
          <div class="detail-pane detail-pane--panel">
            <div class="detail-panes">
              <div class="detail-body">
                <div class="markdown-preview">
                  <p>まず 短いメモ を読む。次に パフォーマンス検証ノート。詳しくは 重い方のノート を見る。それから長い一文がここに続いて、行の終わりまで届く。</p>
                </div>
              </div>
            </div>
            <aside class="link-peek-card"><div class="link-peek-body"></div></aside>
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

describe("a linked note lifted on a wide window", () => {
  beforeAll(async () => {
    await import("../index.css");
    await import("./workspace.css");
    await page.viewport(1280, 800);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("lies at the page's right edge, the page's full height", () => {
    document.body.innerHTML = NOTE_WITH_PEEK;
    const pane = box(".detail-pane");
    const card = box(".link-peek-card");

    expect(card.right).toBeCloseTo(pane.right, 0);
    expect(card.height).toBeCloseTo(pane.height, 0);
  });

  it("covers none of the text being read", () => {
    document.body.innerHTML = NOTE_WITH_PEEK;

    expect(box(".markdown-preview p").right).toBeLessThanOrEqual(box(".link-peek-card").left);
  });
});
