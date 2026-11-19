import type { JSX } from "solid-js";
import CapturePill from "./CapturePill";
import { captureKeyLabel } from "../lib/capture-window";
import { getClientContext } from "../lib/client-context";
import { typedInvoke } from "../lib/commands";
import { t } from "../lib/i18n";

/**
 * The browser harness's stand-in for the OS window (38, 67): the same pill the real window
 * shows (`views/CaptureWindow.tsx`), floated where the OS puts it, over a dimmed page that plays
 * "another app", and labelled for what it stands in for. It answers the same key, sends the
 * same way (`capture_window_sent`, which the harness turns into the same event the app hears),
 * and Esc keeps the draft. It exists only where `isBrowserMock()` holds.
 */
export default function CaptureStandIn(props: { onClose: () => void }): JSX.Element {
  const send = async (text: string): Promise<void> => {
    await typedInvoke("save_quick_capture", { text, client: await getClientContext() });
    await typedInvoke("capture_window_sent");
    props.onClose();
  };

  return (
    <div class="capture-stand-in">
      <button
        type="button"
        class="capture-stand-in-scrim"
        tabIndex={-1}
        aria-label={t().common.close}
        onClick={() => props.onClose()}
      />
      <p class="capture-stand-in-label">{t().reach.captureStandIn}</p>
      <div class="capture-stand-in-window">
        <CapturePill
          hint={t().reach.captureHint(captureKeyLabel())}
          onSend={send}
          onPromote={send}
          onClose={() => props.onClose()}
          // The field keeps a line that did not go; as in the real window, no toast is there
          onError={() => null}
        />
      </div>
    </div>
  );
}
