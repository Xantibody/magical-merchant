import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { page } from "vitest/browser";

/**
 * Android のシステムバーとの重なりは実機を触るまで分からなかった。
 * `--safe-top` / `--safe-bottom` に実寸を集約してあるので、ここで値を差し込んで
 * レイアウトが画面内に収まるかを検証できる。
 */
const ANDROID_SAFE_TOP = "42px";
const ANDROID_SAFE_BOTTOM = "24px";

function setInsets(top: string, bottom: string): void {
  document.documentElement.style.setProperty("--safe-top", top);
  document.documentElement.style.setProperty("--safe-bottom", bottom);
}

function element(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) {
    throw new Error(`expected ${selector} to be mounted`);
  }
  return found;
}

function mountApp(): HTMLElement {
  document.body.innerHTML = `
    <div class="app">
      <nav class="rail"></nav>
      <div class="app-column">
        <header class="mobile-header">header</header>
        <main class="app-main"><div class="view"></div></main>
        <div class="bottom-bar"></div>
        <nav class="bottom-tabs"><a class="bottom-tab">Notes</a></nav>
      </div>
    </div>`;
  const app = document.querySelector<HTMLElement>(".app");
  if (!app) {
    throw new Error("expected .app to be mounted");
  }
  return app;
}

describe("app shell inside the system bars", () => {
  beforeAll(async () => {
    await import("../index.css");
  });

  afterEach(() => {
    document.documentElement.style.removeProperty("--safe-top");
    document.documentElement.style.removeProperty("--safe-bottom");
    document.body.innerHTML = "";
  });

  // html が safe-area ぶんの padding を持つので、.app が 100dvh のままだと
  // 下端が画面外へ出て、下タブと入力バーがナビゲーションバーの裏に回り込む
  it("does not overflow the viewport when the system bars take space", () => {
    setInsets(ANDROID_SAFE_TOP, ANDROID_SAFE_BOTTOM);
    const app = mountApp();

    const { bottom } = app.getBoundingClientRect();

    expect(bottom).toBeLessThanOrEqual(globalThis.innerHeight + 0.5);
  });

  it("keeps the bottom tabs reachable above the navigation bar", () => {
    setInsets(ANDROID_SAFE_TOP, ANDROID_SAFE_BOTTOM);
    mountApp();
    const tabs = element(".bottom-tabs");
    // 下タブはモバイル幅でしか出ない。テストの実行幅に依らず位置だけを見る
    tabs.style.display = "flex";

    const { bottom } = tabs.getBoundingClientRect();
    const navigationBarTop = globalThis.innerHeight - Number.parseInt(ANDROID_SAFE_BOTTOM, 10);

    expect(bottom).toBeLessThanOrEqual(navigationBarTop + 0.5);
  });

  it("uses the whole viewport when there are no system bars", () => {
    setInsets("0px", "0px");
    const app = mountApp();

    expect(app.getBoundingClientRect().height).toBeCloseTo(globalThis.innerHeight, 0);
  });
});

/** レールと、その左端を滑る現在地の線。`top` はビューが決めて style で渡す。 */
function mountRail(markerTop: number, off = false): void {
  document.body.innerHTML = `
    <div class="app">
      <nav class="rail">
        <a class="rail-button rail-button--active"></a>
        <a class="rail-button"></a>
        <span class="rail-marker" style="top:${markerTop}px" ${off ? "data-off" : ""}></span>
        <span class="rail-divider"></span>
        <button class="rail-button rail-button--plain"></button>
      </nav>
      <div class="app-column"><main class="app-main"></main></div>
    </div>`;
}

function mountAction(): HTMLElement {
  document.body.innerHTML = `<button class="icon-button" data-key="⌘N"></button>`;
  return element("[data-key]");
}

/** 札は擬似要素なので、出ているかどうかは content でしか見られない。 */
function badge(target: HTMLElement): string {
  return getComputedStyle(target, "::after").content;
}

describe("the rail tells you where you are", () => {
  beforeAll(async () => {
    await import("../index.css");
    await page.viewport(1280, 800);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("is a 48px column with a hairline down its right edge", () => {
    mountRail(18);

    const rail = element(".rail");
    const style = getComputedStyle(rail);

    expect(rail.getBoundingClientRect().width).toBeCloseTo(48, 0);
    expect(style.borderRightWidth).toBe("1px");
  });

  // 字が無いので、現在地は塗りで言う。ヘッダのタブは文字の重さだけで
  // 示していたが、レールの入口はアイコン 1 つしかない
  it("fills the button you are on and leaves the others bare", () => {
    mountRail(18);

    const active = getComputedStyle(element(".rail-button--active"));
    const idle = getComputedStyle(element(".rail-button:not(.rail-button--active)"));

    expect(active.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(idle.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  });

  // 線は 3 つの面のあいだを滑る。位置は面が決め、滑らかさはここが持つ
  it("slides the marker with a transition on top alone", () => {
    mountRail(58);

    const marker = element(".rail-marker");
    const style = getComputedStyle(marker);
    const rail = element(".rail").getBoundingClientRect();

    expect(marker.getBoundingClientRect().top - rail.top).toBeCloseTo(58, 0);
    expect(marker.getBoundingClientRect().width).toBeCloseTo(2, 0);
    expect(marker.getBoundingClientRect().height).toBeCloseTo(20, 0);
    expect(style.transitionProperty).toContain("top");
    expect(style.transitionDuration).toContain("0.22s");
  });

  // 設定を開いているあいだは線を出さない。面ではないので、滑らせる先もない
  it("hides the marker where there is no mode to point at", () => {
    mountRail(58, true);

    expect(getComputedStyle(element(".rail-marker")).opacity).toBe("0");
  });

  it("leaves no header above the body on a wide window", () => {
    mountApp();

    expect(getComputedStyle(element(".mobile-header")).display).toBe("none");
  });

  it("puts a 30px bar under the body", () => {
    mountApp();

    const bar = element(".bottom-bar");

    expect(bar.getBoundingClientRect().height).toBeCloseTo(30, 0);
    expect(getComputedStyle(bar).borderTopWidth).toBe("1px");
  });

  // 下タブはモバイルのもの。広い窓では帯が二段になる
  it("keeps the bottom tabs off a wide window", () => {
    mountApp();

    expect(getComputedStyle(element(".bottom-tabs")).display).toBe("none");
  });
});

describe("the shell on a phone", () => {
  beforeAll(async () => {
    await import("../index.css");
  });

  afterEach(async () => {
    document.body.innerHTML = "";
    await page.viewport(1280, 800);
  });

  it("swaps the rail for a header and the bottom tabs", async () => {
    await page.viewport(390, 800);
    mountApp();

    expect(getComputedStyle(element(".rail")).display).toBe("none");
    expect(getComputedStyle(element(".mobile-header")).display).toBe("flex");
    expect(getComputedStyle(element(".bottom-tabs")).display).toBe("flex");
    expect(getComputedStyle(element(".bottom-bar")).display).toBe("none");
  });

  // キーボードが出ているあいだ下タブを畳む `body.md-toolbar-open .bottom-tabs`
  // は書式バーの CSS が持っていて、`@media (hover: none)` の中にある。
  // headless Chromium は hover を持つのでここからは試せない — 実機で見る
});

describe("the hint layer", () => {
  beforeAll(async () => {
    await import("../index.css");
  });

  afterEach(() => {
    delete document.documentElement.dataset.hints;
    document.body.innerHTML = "";
  });

  it("draws nothing until the modifier is being held", () => {
    const action = mountAction();

    expect(badge(action)).toBe("none");
  });

  // 札は擬似要素。出ているあいだも DOM のノードは 1 つも増えない
  it("prints the key from the attribute while the modifier is held", () => {
    const action = mountAction();

    document.documentElement.dataset.hints = "";

    expect(badge(action)).toBe('"⌘N"');
    expect(action.childElementCount).toBe(0);
  });

  // 部品ライブラリの集まり(… メニューの行)も data-key を使うが、入っているのは
  // 内部の識別子。役割で外さないと、⌘ を押した瞬間に行の肩へ `item-3` が並ぶ
  it("draws no badge for the identifier a menu collection writes", () => {
    document.body.innerHTML = `<div role="menuitem" data-key="item-3">削除</div>`;
    const row = element("[data-key]");

    document.documentElement.dataset.hints = "";

    expect(badge(row)).toBe("none");
  });
});

/**
 * 同期の器は面の列に 1 つだけ吊るす。入口はレール(広い窓)と帯(狭い窓)の
 * 2 つあるが、開く先は同じ器。
 *
 * ヘッダの下端に吊るす基底(`.popover-anchor { top: 100% }`)はここでは使え
 * ない。この列は窓の高さいっぱいなので真下は画面の外で、`.app` の
 * `overflow: hidden` に刈られる。押すと状態だけ変わって何も見えない。
 */
function mountSyncPopover(): HTMLElement {
  document.body.innerHTML = `
    <div class="app">
      <nav class="rail"></nav>
      <div class="app-column">
        <header class="mobile-header">header</header>
        <main class="app-main"><div class="view"></div></main>
        <div class="popover-anchor popover-anchor--sync">
          <div class="popover" style="width: 260px; height: 180px;">sync</div>
        </div>
        <nav class="bottom-tabs"><a class="bottom-tab">Notes</a></nav>
      </div>
    </div>`;
  return element(".popover");
}

describe("the sync panel", () => {
  beforeAll(async () => {
    await import("../index.css");
  });

  afterEach(async () => {
    document.body.innerHTML = "";
    await page.viewport(1280, 800);
  });

  it("opens beside the rail's foot on a wide window", async () => {
    await page.viewport(1280, 800);
    const rect = mountSyncPopover().getBoundingClientRect();

    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(800);
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(1280);
  });

  it("opens under the band on a phone", async () => {
    await page.viewport(390, 800);
    const rect = mountSyncPopover().getBoundingClientRect();

    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(800);
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(390);
  });
});
