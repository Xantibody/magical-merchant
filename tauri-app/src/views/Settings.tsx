import { createSignal, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import "../styles/settings.css";

interface SyncConfig {
  workers_url: string;
  team_domain: string;
  app_aud: string;
}

export default function Settings() {
  const [workersUrl, setWorkersUrl] = createSignal("");
  const [teamDomain, setTeamDomain] = createSignal("");
  const [appAud, setAppAud] = createSignal("");
  const [authenticated, setAuthenticated] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [message, setMessage] = createSignal("");

  onMount(async () => {
    try {
      const config = await invoke<SyncConfig>("get_sync_config");
      setWorkersUrl(config.workers_url);
      setTeamDomain(config.team_domain);
      setAppAud(config.app_aud);
    } catch {
      // Use defaults
    }

    try {
      const status = await invoke<boolean>("auth_status");
      setAuthenticated(status);
    } catch {
      setAuthenticated(false);
    }
  });

  const handleSave = async () => {
    setSaving(true);
    setMessage("");
    try {
      await invoke("save_sync_config", {
        config: {
          workers_url: workersUrl(),
          team_domain: teamDomain(),
          app_aud: appAud(),
        },
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
      await invoke("auth_login");
      setAuthenticated(true);
      setMessage("Authenticated");
      setTimeout(() => setMessage(""), 2000);
    } catch (e) {
      setMessage(`Auth error: ${e}`);
    }
  };

  const handleLogout = async () => {
    try {
      await invoke("auth_logout");
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

        <label class="settings-label">
          Team Domain
          <input
            type="text"
            class="settings-input"
            value={teamDomain()}
            onInput={(e) => setTeamDomain(e.currentTarget.value)}
            placeholder="your-team"
          />
        </label>

        <label class="settings-label">
          App AUD
          <input
            type="text"
            class="settings-input"
            value={appAud()}
            onInput={(e) => setAppAud(e.currentTarget.value)}
            placeholder="aud-tag-from-cf-access"
          />
        </label>

        <button
          type="button"
          class="settings-button"
          onClick={handleSave}
          disabled={saving()}
        >
          {saving() ? "Saving..." : "Save"}
        </button>
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
