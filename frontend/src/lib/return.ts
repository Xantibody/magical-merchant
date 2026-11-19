import { listen, TauriEvent } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

/**
 * The moment the user comes back to the app: the mirror image of `leave.ts`. While nobody
 * was looking, the CLI, MCP or another device may have rewritten `data/`. The app does not
 * watch files, so coming back is the signal to reread, and to pull the other devices' writes
 * in if the user asked. On Android it is also the only signal that a frozen process has woken.
 *
 * AIDEV-NOTE: every return rereads, however short the absence. Skipping returns under 30 s
 * was tried and dropped (#376): what the CLI or MCP wrote meanwhile stayed off screen, and
 * typing on that stale note had its first save refused as stale
 */

/**
 * Calls `onReturn` when the page becomes visible (Android, a tab switch) and when the window
 * regains focus (desktop, where the page stays visible and only Tauri knows). Resolves to the
 * way to stop watching.
 *
 * AIDEV-NOTE: getCurrentWindow().onFocusChanged is not used. The window module drags in dpi/image and becomes 13% of the startup bundle
 */
export async function watchReturn(onReturn: () => void): Promise<() => void> {
  const onVisible = (): void => {
    if (document.visibilityState === "visible") {
      onReturn();
    }
  };
  document.addEventListener("visibilitychange", onVisible);

  let unlistenFocus: UnlistenFn | undefined;
  try {
    unlistenFocus = await listen(TauriEvent.WINDOW_FOCUS, onReturn);
  } catch {
    // No window (browser harness, tests). visibilitychange alone does the job
  }

  return () => {
    document.removeEventListener("visibilitychange", onVisible);
    unlistenFocus?.();
  };
}
