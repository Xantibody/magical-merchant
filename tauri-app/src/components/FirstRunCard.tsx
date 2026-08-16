import { createSignal, Show } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import { typedInvoke } from "../lib/commands";
import { t } from "../lib/i18n";
import { isImeComposing } from "../lib/ime";

const DISMISSED_KEY = "first-run-dismissed";

interface FirstRunCardProps {
  /** 同期が未設定のときだけ出す。設定済みなら初回でも出す意味がない。 */
  when: boolean;
  onConnected: () => void;
}

/**
 * 初回起動で 1 度だけ出す同期の案内。
 *
 * 同期は必須ではない。設定しないまま使い続けられることを先に伝えないと、
 * 「設定しないと使えない」と読めてしまう。
 */
export default function FirstRunCard(props: FirstRunCardProps): JSX.Element {
  const [dismissed, setDismissed] = createSignal(localStorage.getItem(DISMISSED_KEY) === "1");
  const [url, setUrl] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [failure, setFailure] = createSignal("");

  const close = (): void => {
    localStorage.setItem(DISMISSED_KEY, "1");
    setDismissed(true);
  };

  const connect = (): void => {
    const workersUrl = url().trim();
    if (!workersUrl || saving()) {
      return;
    }
    setSaving(true);
    setFailure("");
    void (async () => {
      try {
        const config = await typedInvoke("get_sync_config");
        await typedInvoke("save_sync_config", { config: { ...config, workers_url: workersUrl } });
        close();
        props.onConnected();
      } catch (error) {
        setFailure(String(error));
      } finally {
        setSaving(false);
      }
    })();
  };

  return (
    <Show when={props.when && !dismissed()}>
      <div class="first-run-overlay">
        <div class="first-run" role="dialog" aria-modal="true" aria-labelledby="first-run-title">
          <Icon name="cloud-check" size={24} />
          <h2 id="first-run-title" class="first-run-title">
            {t().firstRun.title}
          </h2>
          <p class="first-run-body">
            {t().firstRun.body}
            <br />
            {t().firstRun.hint}
          </p>

          <input
            type="url"
            class="first-run-input"
            value={url()}
            placeholder="https://....workers.dev"
            onInput={(e) => setUrl(e.currentTarget.value)}
            onKeyDown={(e) => {
              // 変換確定の Enter は IME のもの。接続には使わない (#102)
              if (e.key === "Enter" && !isImeComposing(e)) {
                e.preventDefault();
                connect();
              }
            }}
          />
          <Show when={failure()}>
            <p class="first-run-error">{failure()}</p>
          </Show>

          <div class="first-run-actions">
            <button
              type="button"
              class="button-primary"
              disabled={!url().trim() || saving()}
              onClick={connect}
            >
              {t().firstRun.connect}
            </button>
            <button type="button" class="button-secondary" onClick={close}>
              {t().firstRun.later}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
