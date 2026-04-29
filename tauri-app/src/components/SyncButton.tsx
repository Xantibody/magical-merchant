import { createSignal, onMount, onCleanup } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { typedInvoke } from "../lib/commands";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import Icon, { type IconName } from "./Icon";

type SyncStatus = "idle" | "syncing" | "success" | "error" | "not-configured";

export default function SyncButton() {
  const [status, setStatus] = createSignal<SyncStatus>("idle");
  const navigate = useNavigate();
  let successTimer: ReturnType<typeof setTimeout> | undefined;
  const unlisteners: UnlistenFn[] = [];

  onMount(async () => {
    try {
      const config = await typedInvoke("get_sync_config");
      if (!config.workers_url) {
        setStatus("not-configured");
      }
    } catch {
      setStatus("not-configured");
    }

    unlisteners.push(
      await listen("sync-complete", () => {
        setStatus("success");
        successTimer = setTimeout(() => setStatus("idle"), 3000);
      }),
    );

    unlisteners.push(
      await listen("sync-error", () => {
        setStatus("error");
      }),
    );
  });

  onCleanup(() => {
    if (successTimer) clearTimeout(successTimer);
    for (const unlisten of unlisteners) unlisten();
  });

  const handleClick = async () => {
    const s = status();
    if (s === "syncing") return;
    if (s === "not-configured") {
      navigate("/settings");
      return;
    }

    setStatus("syncing");
    try {
      await typedInvoke("sync_start");
    } catch {
      setStatus("error");
    }
  };

  const iconName = (): IconName => {
    switch (status()) {
      case "syncing":
        return "cloud-arrow-up";
      case "success":
        return "cloud-check";
      case "error":
      case "not-configured":
        return "cloud-slash";
      default:
        return "cloud-check";
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label="Sync"
      class="sync-button"
      classList={{ syncing: status() === "syncing" }}
    >
      <Icon name={iconName()} size={18} />
    </button>
  );
}
