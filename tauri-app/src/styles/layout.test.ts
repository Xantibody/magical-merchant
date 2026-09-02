import { describe, it, expect, beforeAll, afterEach } from "vitest";

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
      <header class="header">header</header>
      <main class="app-main"><div class="view"></div></main>
      <nav class="bottom-tabs"><a class="bottom-tab">Notes</a></nav>
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
