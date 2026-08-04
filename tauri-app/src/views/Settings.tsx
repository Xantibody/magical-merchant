import { createSignal, onMount, onCleanup, Show } from "solid-js";
import { typedInvoke } from "../lib/commands";
import { EVENTS } from "../lib/events";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "../styles/settings.css";

export default function Settings() {
  const [workersUrl, setWorkersUrl] = createSignal("");
  const [authenticated, setAuthenticated] = createSignal(false);
  const [editable, setEditable] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [message, setMessage] = createSignal("");

  const unlisteners: UnlistenFn[] = [];

  onMount(async () => {
    try {
      const config = await typedInvoke("get_sync_config");
      setWorkersUrl(config.workers_url);
    } catch {
      // Use defaults
    }

    try {
      setEditable(await typedInvoke("is_sync_config_editable"));
    } catch {
      setEditable(false);
    }

    try {
      const status = await typedInvoke("auth_status");
      setAuthenticated(status);
    } catch {
      setAuthenticated(false);
    }

    // Android はディープリンク経由で認証が完了するので、イベントで状態を反映する
    unlisteners.push(
      await listen(EVENTS.AUTH_SUCCESS, () => {
        setAuthenticated(true);
        setMessage("Authenticated");
        setTimeout(() => setMessage(""), 2000);
      }),
    );
    unlisteners.push(
      await listen<string>(EVENTS.AUTH_ERROR, (e) => {
        setAuthenticated(false);
        setMessage(`Auth error: ${e.payload}`);
      }),
    );
  });

  onCleanup(() => {
    for (const unlisten of unlisteners) unlisten();
  });

  const handleSave = async () => {
    setSaving(true);
    setMessage("");
    try {
      await typedInvoke("save_sync_config", {
        config: { workers_url: workersUrl() },
      });
      setMessage("Saved");
      setTimeout(() => setMessage(""), 2000);
    } catch (e) {
      setMessage(`Error: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  const handleLogin = async () => {
    setMessage("Continue login in your browser...");
    try {
      // デスクトップ(ループバック)はコマンド完了時点でトークン保存済み。
      // Android はブラウザを開くだけで、完了はディープリンクの auth-success で通知される
      await typedInvoke("auth_login");
      const status = await typedInvoke("auth_status");
      setAuthenticated(status);
      if (status) {
        setMessage("Authenticated");
        setTimeout(() => setMessage(""), 2000);
      }
    } catch (e) {
      setMessage(`Auth error: ${e}`);
    }
  };

  const handleLogout = async () => {
    try {
      await typedInvoke("auth_logout");
      setAuthenticated(false);
      setMessage("Logged out");
      setTimeout(() => setMessage(""), 2000);
    } catch (e) {
      setMessage(`Error: ${e}`);
    }
  };

  return (
    <div class="settings">
      <h2 class="settings-title">Sync Settings</h2>

      <div class="settings-section">
        <Show
          when={editable()}
          fallback={
            <div class="settings-label">
              Workers URL
              <span class="settings-value">{workersUrl() || "Not configured"}</span>
            </div>
          }
        >
          <label class="settings-label">
            Workers URL
            <input
              type="url"
              class="settings-input"
              value={workersUrl()}
              onInput={(e) => setWorkersUrl(e.currentTarget.value)}
              placeholder="https://magical-merchant-sync.your-account.workers.dev"
            />
          </label>
          <button type="button" class="settings-button" onClick={handleSave} disabled={saving()}>
            {saving() ? "Saving..." : "Save"}
          </button>
        </Show>
      </div>

      <div class="settings-section">
        <div class="settings-auth-status">
          Status: {authenticated() ? "Authenticated" : "Not authenticated"}
        </div>

        {authenticated() ? (
          <button type="button" class="settings-button secondary" onClick={handleLogout}>
            Logout
          </button>
        ) : (
          <>
            <button
              type="button"
              class="settings-button"
              onClick={handleLogin}
              disabled={!workersUrl().trim()}
            >
              Login with Google
            </button>
            {!workersUrl().trim() && (
              <p class="settings-hint">Save the Workers URL above to enable login.</p>
            )}
          </>
        )}
      </div>

      {message() && <div class="settings-message">{message()}</div>}
    </div>
  );
}
