import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { JSX } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import CapturePill from "../components/CapturePill";
import { captureKeyLabel, isCaptureKey } from "../lib/capture-window";
import { getClientContext } from "../lib/client-context";
import { typedInvoke } from "../lib/commands";
import { formatClock } from "../lib/day-labels";
import { t } from "../lib/i18n";
import { applyTheme, theme } from "../lib/theme";

/** Asks the app for something about this window. The browser harness has no window to ask. */
async function tell(command: "capture_window_hide" | "capture_window_sent"): Promise<void> {
  try {
    await typedInvoke(command);
  } catch {
    // No window behind the page (the browser harness): nothing to hide, nobody to tell
  }
}

/** Starts listening, and never lets a missing event bridge throw out of a mount. */
async function hear(event: string, run: () => void): Promise<UnlistenFn | null> {
  try {
    return await listen(event, run);
  } catch {
    return null;
  }
}

/** A key the OS also hears may arrive twice (its handler and the page's); one send is meant. */
const TWICE_MS = 300;

/**
 * The window the OS key floats over any app (38, 67): the place pill and nothing else. Enter
 * records and the window goes; the same key pressed again does the same; Esc puts it away and
 * the half-typed line waits in it (and in the app's own field, which keeps the same draft) for
 * the next time. What it records the main window hears about (`capture_window_sent`), so a
 * Scrawl on screen there rereads.
 */
export default function CaptureWindow(): JSX.Element {
  applyTheme(theme());
  /** When the last line went, said under the pill so a press is seen to have landed. */
  const [last, setLast] = createSignal<string | null>(null);
  /** Bumped when the window is shown: the pill is built again and reads the draft anew. */
  const [shown, setShown] = createSignal(0);
  let sentAt = 0;

  const send = async (text: string): Promise<void> => {
    await typedInvoke("save_quick_capture", { text, client: await getClientContext() });
    setLast(formatClock(new Date()));
    await tell("capture_window_sent");
    await tell("capture_window_hide");
  };

  /** The key again (67): what is typed goes; with nothing typed the window simply goes away. */
  const sendOrHide = (): void => {
    const now = performance.now();
    if (now - sentAt < TWICE_MS) {
      return;
    }
    sentAt = now;
    const field = document.querySelector<HTMLTextAreaElement>(".capture-input");
    if (!field?.value.trim()) {
      void tell("capture_window_hide");
      return;
    }
    document.querySelector<HTMLButtonElement>(".capture-send")?.click();
  };

  onMount(() => {
    const stops: (UnlistenFn | null)[] = [];
    void (async () => {
      stops.push(
        await hear("capture://open", () => setShown((n) => n + 1)),
        await hear("capture://send", sendOrHide),
      );
    })();
    // Where the window itself has the keys and the OS passed the key on
    const onKey = (e: KeyboardEvent): void => {
      if (isCaptureKey(e)) {
        e.preventDefault();
        sendOrHide();
      }
    };
    globalThis.addEventListener("keydown", onKey);
    onCleanup(() => {
      globalThis.removeEventListener("keydown", onKey);
      for (const stop of stops) {
        stop?.();
      }
    });
  });

  return (
    <Show when={String(shown())} keyed>
      <CapturePill
        hint={
          last() ? t().reach.captureLast(last() ?? "") : t().reach.captureHint(captureKeyLabel())
        }
        onSend={send}
        // A window over another app has no Note to open into: ⌘↵ sends the line as well
        onPromote={send}
        onClose={() => {
          void tell("capture_window_hide");
        }}
        // The pill says a failed send itself (the field keeps the line); there is no toast here
        onError={() => setLast(null)}
      />
    </Show>
  );
}
