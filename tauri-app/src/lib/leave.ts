import { listen, TauriEvent } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

/**
 * The moment the user leaves the app: the page is hidden (Android sends the app to the
 * background, a tab is switched), the window loses focus (desktop, where the page stays
 * visible and only Tauri knows), or the page is being unloaded. It is the one moment to
 * write what is still pending and to send it on, because on Android the process may not
 * be back; `AppLayout`'s return hook is its mirror image.
 */

type LeaveHandler = () => void | Promise<void>;

export interface LeaveHandlers {
  /** Registers a handler and returns the way to forget it, for the screen's cleanup. */
  register: (handler: LeaveHandler) => () => void;
  /** Runs every handler and waits for all of them. One that throws does not stop the rest. */
  run: () => Promise<void>;
}

/** The handlers the open screens have registered. Workspace registers its pending save here. */
export function createLeaveHandlers(): LeaveHandlers {
  const handlers = new Set<LeaveHandler>();
  return {
    register: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    run: async () => {
      await Promise.allSettled(
        [...handlers].map(async (handler) => {
          await handler();
        }),
      );
    },
  };
}

/**
 * Calls `onLeave` once per leave. Hiding a desktop window sends both the blur and the
 * hidden, so the second one is swallowed until the app has come back (visible, or focus).
 * Resolves to the way to stop watching.
 *
 * `getCurrentWindow().onFocusChanged` is not used, for the same reason as in AppLayout:
 * the window module becomes 13% of the startup bundle. `listen` on the window events is enough.
 */
export async function watchLeave(onLeave: () => void): Promise<() => void> {
  let away = false;
  const leave = (): void => {
    if (away) {
      return;
    }
    away = true;
    onLeave();
  };
  const back = (): void => {
    away = false;
  };

  const onVisibility = (): void => {
    if (document.visibilityState === "hidden") {
      leave();
    } else {
      back();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  globalThis.addEventListener("pagehide", leave);

  // No window (browser harness, tests without the event mock): the page events alone do the job
  const unlisteners: UnlistenFn[] = [];
  try {
    unlisteners.push(
      await listen(TauriEvent.WINDOW_BLUR, leave),
      await listen(TauriEvent.WINDOW_FOCUS, back),
    );
  } catch {
    // Nothing to undo: a listen that failed registered nothing
  }

  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    globalThis.removeEventListener("pagehide", leave);
    for (const unlisten of unlisteners) {
      unlisten();
    }
  };
}
