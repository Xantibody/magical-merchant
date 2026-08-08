import { createSignal, onMount, onCleanup, Show } from "solid-js";
import { typedInvoke } from "../lib/commands";
import { EVENTS } from "../lib/events";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import "../styles/settings.css";
import type { JSX } from "solid-js";

export default function Settings(): JSX.Element {
  const [workersUrl, setWorkersUrl] = createSignal("");
  const [authenticated, setAuthenticated] = createSignal(false);
  const [editable, setEditable] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [message, setMessage] = createSignal("");

  const unlisteners: UnlistenFn[] = [];

  const flash = (text: string): void => {
    setMessage(text);
    setTimeout(() => setMessage(""), 2000);
  };

  onMount(async () => {
    try {
      const config = await typedInvoke("get_sync_config");
      setWorkersUrl(config.workers_url);
    } catch {
      // 未設定のまま開いた場合。空欄で始める
    }

    try {
      setEditable(await typedInvoke("is_sync_config_editable"));
    } catch {
      setEditable(false);
    }

    try {
      setAuthenticated(await typedInvoke("auth_status"));
    } catch {
      setAuthenticated(false);
    }

    // Android はディープリンク経由で認証が完了するので、イベントで状態を反映する
    unlisteners.push(
      await listen(EVENTS.AUTH_SUCCESS, () => {
        setAuthenticated(true);
        flash("ログインしました");
      }),
    );
    unlisteners.push(
      await listen<string>(EVENTS.AUTH_ERROR, (e) => {
        setAuthenticated(false);
        setMessage(`ログインに失敗しました: ${e.payload}`);
      }),
    );
  });

  onCleanup(() => {
    for (const unlisten of unlisteners) {
      unlisten();
    }
  });

  const save = async (): Promise<void> => {
    setSaving(true);
    setMessage("");
    try {
      // auto_sync は同期ポップオーバー側が持つ設定なので、現在値を保って書き戻す
      const current = await typedInvoke("get_sync_config");
      await typedInvoke("save_sync_config", {
        config: { ...current, workers_url: workersUrl() },
      });
      flash("保存しました");
    } catch (error) {
      setMessage(`保存できませんでした: ${error}`);
    } finally {
      setSaving(false);
    }
  };

  const login = async (): Promise<void> => {
    setMessage("ブラウザで続けてください…");
    try {
      // デスクトップ(ループバック)はコマンド完了時点でトークン保存済み。
      // Android はブラウザを開くだけで、完了はディープリンクの auth-success で通知される
      await typedInvoke("auth_login");
      const status = await typedInvoke("auth_status");
      setAuthenticated(status);
      if (status) {
        flash("ログインしました");
      }
    } catch (error) {
      setMessage(`ログインに失敗しました: ${error}`);
    }
  };

  const logout = async (): Promise<void> => {
    try {
      await typedInvoke("auth_logout");
      setAuthenticated(false);
      flash("ログアウトしました");
    } catch (error) {
      setMessage(`ログアウトできませんでした: ${error}`);
    }
  };

  return (
    <div class="settings-scroll">
      <div class="settings">
        <h1 class="settings-title">設定</h1>

        <section class="settings-section">
          <h2 class="settings-section-label">SERVER</h2>
          <Show
            when={editable()}
            fallback={
              <p class="settings-readonly">
                Workers URL
                <span>{workersUrl() || "未設定"}</span>
              </p>
            }
          >
            <label class="settings-field">
              <span class="settings-field-label">Workers URL</span>
              <input
                type="url"
                class="settings-input"
                value={workersUrl()}
                onInput={(e) => setWorkersUrl(e.currentTarget.value)}
                placeholder="https://....workers.dev"
              />
            </label>
            <div class="settings-actions">
              <button
                type="button"
                class="button-primary"
                onClick={() => void save()}
                disabled={saving()}
              >
                {saving() ? "保存中…" : "保存"}
              </button>
            </div>
          </Show>
        </section>

        <section class="settings-section">
          <h2 class="settings-section-label">ACCOUNT</h2>

          <p class="settings-status">
            <span class="settings-dot" classList={{ "settings-dot--on": authenticated() }} />
            {authenticated() ? "ログイン済み" : "未ログイン"}
          </p>

          <div class="settings-actions">
            <Show
              when={authenticated()}
              fallback={
                <button
                  type="button"
                  class="button-primary"
                  onClick={() => void login()}
                  disabled={!workersUrl().trim()}
                >
                  Google でログイン
                </button>
              }
            >
              <button type="button" class="button-secondary" onClick={() => void logout()}>
                ログアウト
              </button>
            </Show>
          </div>

          <Show when={!authenticated() && !workersUrl().trim()}>
            <p class="settings-hint">ログインするには、先に Workers URL を保存してください。</p>
          </Show>
        </section>

        <Show when={message()}>
          <p class="settings-message">{message()}</p>
        </Show>
      </div>
    </div>
  );
}
