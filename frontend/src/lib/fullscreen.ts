/**
 * The "fullscreen at startup" setting. Concerns the macOS desktop build only.
 *
 * Kept in localStorage like the theme (`theme.ts`) and the language (`i18n.ts`).
 * The window state is not something for the Rust side to hold: what reads it at
 * the next startup is this WebView itself, and one call to
 * `getCurrentWindow().setFullscreen` enters the same native fullscreen (its own
 * Space) as the green button.
 */

import { isMacDesktop } from "./platform";

const STORAGE_KEY = "start-fullscreen";

export function readStartFullscreen(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "true";
}

export function writeStartFullscreen(on: boolean): void {
  localStorage.setItem(STORAGE_KEY, String(on));
}

/**
 * Makes the current window fullscreen. The browser harness and the tests have no
 * window, and the call fails. One setting is no reason to halt startup, so stay silent.
 */
export async function enterFullscreen(): Promise<void> {
  try {
    // The window module brings dpi/image along and weighs 14 kB. It is called only
    // from here and from Settings, so keep it out of the startup bundle
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setFullscreen(true);
  } catch {
    // No window (harness, tests) or no permission. Either way only the look stays the same
  }
}

/** Called at startup. Touches the window only on a Mac with the setting on. */
export async function applyStartFullscreen(userAgent: string = navigator.userAgent): Promise<void> {
  if (!isMacDesktop(userAgent) || !readStartFullscreen()) {
    return;
  }
  await enterFullscreen();
}
