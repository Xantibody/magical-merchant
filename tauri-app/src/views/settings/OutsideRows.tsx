/**
 * The ways into Scrawl from outside the app, said where they can be looked up and tried: the OS
 * key's window (38, 67), the link a Spotlight Shortcut opens (78), and on Android the icon's held
 * shortcuts and Share. Every one of them has a visible way to try it here, so none is a key or a
 * gesture only someone told about would find.
 */

import { createSignal, Show } from "solid-js";
import type { JSX } from "solid-js";
import {
  captureKeyLabel,
  deliverMockLink,
  isBrowserMock,
  scrawlLink,
  setStandIn,
  SHORTCUT_URL,
} from "../../lib/capture-window";
import { typedInvoke } from "../../lib/commands";
import { t } from "../../lib/i18n";
import { Row } from "./Rows";

/** A desktop: a pointer that hovers. A phone has the held pill, the icon and Share instead */
function desktop(): boolean {
  return globalThis.matchMedia("(hover: hover)").matches;
}

/** The window the key floats: the real one in the app, the page's stand-in in the harness. */
async function tryWindow(): Promise<void> {
  if (isBrowserMock()) {
    setStandIn(true);
    return;
  }
  try {
    await typedInvoke("capture_window_show");
  } catch {
    // An older shell without the window: the key's row still says what it would do
  }
}

export default function OutsideRows(props: { onSaid: (text: string) => void }): JSX.Element {
  /** Whether the link just went to the clipboard: the button says so for a moment. */
  const [copied, setCopied] = createSignal(false);

  const copyLink = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(SHORTCUT_URL);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      props.onSaid(t().reach.copyFailed);
    }
  };

  return (
    <section class="settings-outside" aria-label={t().reach.outsideTitle}>
      <h3 class="settings-outside-title">{t().reach.outsideTitle}</h3>
      <Show
        when={desktop()}
        fallback={
          <Row label={t().reach.phoneOnly} desc={t().reach.phoneOnlySub}>
            <span />
          </Row>
        }
      >
        <Row label={t().reach.outsideKey} desc={t().reach.outsideKeySub(captureKeyLabel())}>
          <div class="settings-outside-actions">
            <kbd class="settings-key">{captureKeyLabel()}</kbd>
            <button
              type="button"
              class="button-secondary"
              onClick={() => {
                void tryWindow();
              }}
            >
              {t().reach.outsideTry}
            </button>
          </div>
        </Row>
        <Row label={t().reach.outsideLink} desc={t().reach.outsideLinkSub} tall>
          <div class="settings-outside-link">
            <code class="settings-link-url">{SHORTCUT_URL}…</code>
            <div class="settings-outside-actions">
              <button
                type="button"
                class="button-secondary"
                onClick={() => {
                  void copyLink();
                }}
              >
                {copied() ? t().reach.linkCopied : t().reach.copyLink}
              </button>
              {/* Only the harness can play Spotlight; in the app the link is tried from there */}
              <Show when={isBrowserMock()}>
                <button
                  type="button"
                  class="button-secondary"
                  title={t().reach.mock}
                  onClick={() => deliverMockLink(scrawlLink(t().reach.tryLinkText))}
                >
                  {t().reach.tryLink}
                </button>
              </Show>
            </div>
          </div>
        </Row>
      </Show>
    </section>
  );
}
