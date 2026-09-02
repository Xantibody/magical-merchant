/**
 * 「起動時に全画面」の設定。macOS のデスクトップ版だけの話。
 *
 * テーマ(`theme.ts`)や言語(`i18n.ts`)と同じく localStorage に残す。
 * 窓の状態は Rust 側に持たせるものではない — 次回の起動で読むのは
 * この WebView 自身で、`getCurrentWindow().setFullscreen` を呼ぶだけで
 * 緑ボタンと同じネイティブの全画面(専用 Space)に入れる。
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { isMacDesktop } from "./platform";

const STORAGE_KEY = "start-fullscreen";

export function readStartFullscreen(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "true";
}

export function writeStartFullscreen(on: boolean): void {
  localStorage.setItem(STORAGE_KEY, String(on));
}

/**
 * 今の窓を全画面にする。ブラウザハーネスやテストには窓が無く、
 * 呼び出しが落ちる。設定ひとつのために起動を止める理由はないので黙る。
 */
export async function enterFullscreen(): Promise<void> {
  try {
    await getCurrentWindow().setFullscreen(true);
  } catch {
    // 窓が無い(ハーネス・テスト)か、権限が無い。どちらも見た目が変わらないだけ
  }
}

/** 起動時に呼ぶ。Mac で設定が入っているときだけ窓に触る。 */
export async function applyStartFullscreen(userAgent: string = navigator.userAgent): Promise<void> {
  if (!isMacDesktop(userAgent) || !readStartFullscreen()) {
    return;
  }
  await enterFullscreen();
}
