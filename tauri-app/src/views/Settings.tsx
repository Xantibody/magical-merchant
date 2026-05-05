import { createSignal, onMount, Show } from "solid-js";
import { typedInvoke } from "../lib/commands";
import "../styles/settings.css";

export default function Settings() {
  const [workersUrl, setWorkersUrl] = createSignal("");
  const [authenticated, setAuthenticated] = createSignal(false);
  const [editable, setEditable] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [message, setMessage] = createSignal("");

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
    setMessage("");
    try {
      await typedInvoke("auth_login");
      setAuthenticated(true);
      setMessage("Authenticated");
      setTimeout(() => setMessage(""), 2000);
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
          <button type="button" class="settings-button" onClick={handleLogin}>
            Login with Cloudflare Access
          </button>
        )}
      </div>

      {message() && <div class="settings-message">{message()}</div>}
    </div>
  );
}
