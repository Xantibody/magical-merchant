/**
 * Writing into Scrawl from outside the app (38, 67, 78). The desktop app registers one key with
 * the OS (`src-tauri/src/capture.rs`): pressed anywhere it floats a small window holding the
 * place pill's field (`capture.html`), pressed again it sends. A `magical-merchant://scrawl`
 * link (what Spotlight runs through a Shortcut) writes the same line without the window. Both
 * tell the main window by one event, so whatever Scrawl it shows rereads and says what came in.
 *
 * The browser harness has no OS to register a key with and no Spotlight: there the page plays
 * the window over itself (`stand-in`), and `__mockOpenUrl` delivers a link as the OS would
 * (`dev/ipc-mock.js`). Neither has run inside the real app here.
 */

import { createSignal } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { isMacDesktop } from "./platform";

/** The event the capture window and the deep link send after writing a line. */
const CAPTURED_EVENT = "scrawl-captured";

/** What wrote the line: the floating window, or a link from Spotlight / Shortcuts. */
export interface Captured {
  via: "window" | "link";
}

/** The key the OS hands the app (`CommandOrControl+Shift+Space` in capture.rs). */
export function captureKeyLabel(): string {
  return isMacDesktop() ? "⌘⇧Space" : "Ctrl+Shift+Space";
}

/** Whether a keydown is that key. The window sees it when it is the one focused. */
export function isCaptureKey(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.code === "Space";
}

/** Whether the page runs in the browser harness rather than the app (`dev/ipc-mock.js`). */
export function isBrowserMock(): boolean {
  return "__MM_BROWSER_MOCK__" in globalThis;
}

/** The link a Shortcut opens to write one line; the words go after it, encoded. */
export const SHORTCUT_URL = "magical-merchant://scrawl?text=";

/** The link that writes `text` as one Scrawl line. */
export function scrawlLink(text: string): string {
  return `${SHORTCUT_URL}${encodeURIComponent(text)}`;
}

/**
 * Whether the harness's stand-in for the OS window is up. Module-wide, since both the key (in
 * AppLayout) and Settings' "try it" raise it.
 */
const [standIn, setStandIn] = createSignal(false);
export { setStandIn, standIn };

/** Delivers a link the way the OS would, in the harness. Nothing to deliver to in the app. */
export function deliverMockLink(url: string): boolean {
  // The harness's own hook (dev/ipc-mock.js) is named so it cannot be mistaken for the app's
  const open = Reflect.get(globalThis, "__mockOpenUrl") as ((raw: string) => void) | undefined;
  if (!open) {
    return false;
  }
  open(url);
  return true;
}

/** Runs `run` for every line written from outside. Resolves to the way to stop; never rejects. */
export async function watchCaptured(run: (captured: Captured) => void): Promise<() => void> {
  let unlisten: UnlistenFn | undefined;
  try {
    unlisten = await listen<Captured>(CAPTURED_EVENT, (event) => run(event.payload));
  } catch {
    // No event bridge (a test without the mock): nothing from outside can arrive either
  }
  return () => unlisten?.();
}
