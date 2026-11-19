/**
 * The sync page of Settings: the Workers URL this device syncs through, and the account
 * it signs in with.
 */

import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { typedInvoke } from "../../lib/commands";
import { EVENTS } from "../../lib/events";
import { t } from "../../lib/i18n";
import { syncErrorKind } from "../../lib/sync-status";
import { Row } from "./Rows";

/** The Workers URL field. An ID is needed to tie the row's label to it with `for`. */
const WORKERS_URL_FIELD = "settings-workers-url";

/** The line at the foot of a Settings page. Settings owns it; a page only writes to it. */
interface SettingsMessage {
  /** Shows the text until something replaces it. An empty string clears the line. */
  setMessage: (text: string) => void;
  /** Shows the text for two seconds. */
  flash: (text: string) => void;
}

interface SyncSettings {
  workersUrl: Accessor<string>;
  setWorkersUrl: (url: string) => void;
  authenticated: Accessor<boolean>;
  editable: Accessor<boolean>;
  saving: Accessor<boolean>;
  save: () => Promise<void>;
  login: () => Promise<void>;
  logout: () => Promise<void>;
}

/**
 * What the sync page shows and does.
 *
 * AIDEV-NOTE: Settings creates this, not SyncPage. Settings rebuilds a page on every
 * switch and this has to outlive that: the config is read once when Settings opens,
 * the auth events are heard whichever page is shown, and a URL typed but not saved is
 * still there after a look at another page
 */
export function createSyncSettings({ setMessage, flash }: SettingsMessage): SyncSettings {
  const [workersUrl, setWorkersUrl] = createSignal("");
  const [authenticated, setAuthenticated] = createSignal(false);
  const [editable, setEditable] = createSignal(false);
  const [saving, setSaving] = createSignal(false);

  const unlisteners: UnlistenFn[] = [];

  onMount(async () => {
    try {
      const config = await typedInvoke("get_sync_config");
      setWorkersUrl(config.workers_url);
    } catch (error) {
      // Opened with nothing configured, it starts blank. Only a corrupt config is
      // reported: if it looked like a blank one, a save meant as a re-entry would overwrite it
      if (syncErrorKind(error) === "configCorrupt") {
        setMessage(t().sync.configCorrupt);
      }
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

    // On Android the sign-in completes through a deep link, so the state is updated from events
    unlisteners.push(
      await listen(EVENTS.AUTH_SUCCESS, () => {
        setAuthenticated(true);
        flash(t().settings.signedInMessage);
      }),
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
      // auto_sync belongs to the sync popover, so its current value is kept and written back
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
      // Desktop finishes the sign-in in an in-app window; the token is saved by the time the command returns.
      // Android only opens the browser; completion is reported by the auth-success deep link
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

  return { workersUrl, setWorkersUrl, authenticated, editable, saving, save, login, logout };
}

export default function SyncPage(props: { sync: SyncSettings }): JSX.Element {
  return (
    <>
      <Row
        label={t().settings.workersUrl}
        desc={t().settings.workersUrlDesc}
        labelFor={props.sync.editable() ? WORKERS_URL_FIELD : undefined}
        tall
      >
        <Show
          when={props.sync.editable()}
          fallback={
            // Read-only where the config file fixes it
            <p class="settings-readonly">{props.sync.workersUrl() || t().settings.notSet}</p>
          }
        >
          <input
            id={WORKERS_URL_FIELD}
            type="url"
            class="settings-input settings-input--mono"
            value={props.sync.workersUrl()}
            onInput={(e) => props.sync.setWorkersUrl(e.currentTarget.value)}
            placeholder="https://....workers.dev"
          />
          <div class="settings-actions">
            <button
              type="button"
              class="button-primary"
              onClick={() => {
                void props.sync.save();
              }}
              disabled={props.sync.saving()}
            >
              {props.sync.saving() ? t().common.saving : t().common.save}
            </button>
          </div>
        </Show>
      </Row>

      <Row label={t().settings.account} desc={t().settings.accountDesc} tall>
        <p class="settings-status">
          <span
            class="settings-dot"
            classList={{ "settings-dot--on": props.sync.authenticated() }}
          />
          {props.sync.authenticated() ? t().settings.signedIn : t().settings.notSignedIn}
        </p>

        <div class="settings-actions">
          <Show
            when={props.sync.authenticated()}
            fallback={
              <button
                type="button"
                class="button-primary"
                onClick={() => {
                  void props.sync.login();
                }}
                disabled={!props.sync.workersUrl().trim()}
              >
                {t().settings.signInGoogle}
              </button>
            }
          >
            <button
              type="button"
              class="button-secondary"
              onClick={() => {
                void props.sync.logout();
              }}
            >
              {t().settings.signOut}
            </button>
          </Show>
        </div>

        <Show when={!props.sync.authenticated() && !props.sync.workersUrl().trim()}>
          <p class="settings-hint">{t().settings.signInHint}</p>
        </Show>
      </Row>
    </>
  );
}
