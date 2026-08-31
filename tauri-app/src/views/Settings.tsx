import { createResource, createSignal, For, onMount, onCleanup, Show } from "solid-js";
import { A } from "@solidjs/router";
import Icon from "../components/Icon";
import { typedInvoke } from "../lib/commands";
import { EVENTS } from "../lib/events";
import { applyLocale, readStoredLocale, t } from "../lib/i18n";
import type { LocalePreference } from "../lib/i18n";
import { ROUTES } from "../lib/routes";
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
  const [localePreference, setLocalePreference] =
    createSignal<LocalePreference>(readStoredLocale());
  const [templates] = createResource(() => typedInvoke("list_templates"));

  const chooseLocale = (preference: LocalePreference): void => {
    setLocalePreference(preference);
    applyLocale(preference);
  };

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
        flash(t().settings.signedInMessage);
      }),
    );
    unlisteners.push(
      await listen<string>(EVENTS.AUTH_ERROR, (e) => {
        setAuthenticated(false);
        setMessage(t().settings.signInFailed(String(e.payload)));
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
      flash(t().common.saved);
    } catch (error) {
      setMessage(t().settings.saveFailed(String(error)));
    } finally {
      setSaving(false);
    }
  };

  const login = async (): Promise<void> => {
    setMessage(t().settings.continueSignIn);
    try {
      // デスクトップはアプリ内の窓でログインを終え、コマンド完了時点でトークン保存済み。
      // Android はブラウザを開くだけで、完了はディープリンクの auth-success で通知される
      await typedInvoke("auth_login");
      const status = await typedInvoke("auth_status");
      setAuthenticated(status);
      if (status) {
        flash(t().settings.signedInMessage);
      }
    } catch (error) {
      setMessage(t().settings.signInFailed(String(error)));
    }
  };

  const logout = async (): Promise<void> => {
    try {
      await typedInvoke("auth_logout");
      setAuthenticated(false);
      flash(t().settings.signedOutMessage);
    } catch (error) {
      setMessage(t().settings.signOutFailed(String(error)));
    }
  };

  return (
    <div class="settings-scroll">
      <div class="settings">
        <h1 class="settings-title">{t().settings.title}</h1>

        <section class="settings-section">
          <h2 class="settings-section-label">LANGUAGE</h2>
          {/* テーマと違い巡回では選べない。押すたびに読めない言語を通る */}
          <div class="settings-choices" role="radiogroup" aria-label={t().settings.language}>
            <For
              each={
                [
                  ["system", t().settings.languageSystem],
                  ["ja", t().settings.languageJa],
                  ["en", t().settings.languageEn],
                ] as [LocalePreference, string][]
              }
            >
              {([preference, label]) => (
                <button
                  type="button"
                  role="radio"
                  class="settings-choice"
                  classList={{ "settings-choice--on": localePreference() === preference }}
                  aria-checked={localePreference() === preference}
                  onClick={() => chooseLocale(preference)}
                >
                  {label}
                </button>
              )}
            </For>
          </div>
        </section>

        <section class="settings-section">
          <h2 class="settings-section-label">TEMPLATES</h2>
          <A href={ROUTES.TEMPLATES} class="settings-link">
            <Icon name="file-text" size={16} />
            <span class="settings-link-label">{t().templates.manage}</span>
            <span class="settings-link-count">
              {t().templates.count((templates() ?? []).length)}
            </span>
            <Icon name="caret-right" size={14} />
          </A>
          <p class="settings-hint">{t().templates.manageHint}</p>
        </section>

        <section class="settings-section">
          <h2 class="settings-section-label">SERVER</h2>
          <Show
            when={editable()}
            fallback={
              <p class="settings-readonly">
                Workers URL
                <span>{workersUrl() || t().settings.notSet}</span>
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
                {saving() ? t().common.saving : t().common.save}
              </button>
            </div>
          </Show>
        </section>

        <section class="settings-section">
          <h2 class="settings-section-label">ACCOUNT</h2>

          <p class="settings-status">
            <span class="settings-dot" classList={{ "settings-dot--on": authenticated() }} />
            {authenticated() ? t().settings.signedIn : t().settings.notSignedIn}
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
                  {t().settings.signInGoogle}
                </button>
              }
            >
              <button type="button" class="button-secondary" onClick={() => void logout()}>
                {t().settings.signOut}
              </button>
            </Show>
          </div>

          <Show when={!authenticated() && !workersUrl().trim()}>
            <p class="settings-hint">{t().settings.signInHint}</p>
          </Show>
        </section>

        <Show when={message()}>
          <p class="settings-message">{message()}</p>
        </Show>
      </div>
    </div>
  );
}
