import { createSignal, onMount, onCleanup, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { typedInvoke } from "../lib/commands";
import { EVENTS } from "../lib/events";
import { ROUTES } from "../lib/routes";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import Icon, { type IconName } from "./Icon";
import { describeSyncError, describeSyncResult, type SyncResultPayload } from "../lib/sync-status";

type SyncStatus = "idle" | "syncing" | "success" | "error" | "needs-setup";

export default function SyncButton() {
  const [status, setStatus] = createSignal<SyncStatus>("idle");
  const [message, setMessage] = createSignal("");
  const navigate = useNavigate();
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  const unlisteners: UnlistenFn[] = [];

  const clearResetTimer = () => {
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = undefined;
  };

  /** 数秒後に idle へ戻る表示（成功など） */
  const showTransient = (s: SyncStatus, msg: string) => {
    clearResetTimer();
    setStatus(s);
    setMessage(msg);
    resetTimer = setTimeout(() => {
      setStatus("idle");
      setMessage("");
    }, 4000);
  };

  /** ユーザーが対処するまで残す表示（エラー・要設定） */
  const showPersistent = (s: SyncStatus, msg: string) => {
    clearResetTimer();
    setStatus(s);
    setMessage(msg);
  };

  /** 設定とログイン状態を確認して、押す前に「同期できない理由」を表示する */
  const checkReadiness = async () => {
    try {
      const config = await typedInvoke("get_sync_config");
      if (!config.workers_url) {
        showPersistent("needs-setup", "Sync is not set up — click to open Settings");
        return;
      }
      const authed = await typedInvoke("auth_status");
      if (!authed) {
        showPersistent("needs-setup", "Not logged in — click to open Settings");
        return;
      }
      clearResetTimer();
      setStatus("idle");
      setMessage("");
    } catch {
      showPersistent("needs-setup", "Sync is not set up — click to open Settings");
    }
  };

  const applyError = (err: unknown) => {
    const ui = describeSyncError(err);
    if (!ui) return;
    showPersistent(ui.status, ui.message);
  };

  onMount(async () => {
    await checkReadiness();

    unlisteners.push(
      await listen<SyncResultPayload>(EVENTS.SYNC_COMPLETE, (e) => {
        const ui = describeSyncResult(e.payload);
        if (ui.status === "success") {
          showTransient("success", ui.message);
        } else {
          showPersistent(ui.status, ui.message);
        }
      }),
    );

    unlisteners.push(await listen<unknown>(EVENTS.SYNC_ERROR, (e) => applyError(e.payload)));

    // ログイン完了（ループバック/ディープリンク）を反映する
    unlisteners.push(
      await listen(EVENTS.AUTH_SUCCESS, () => {
        void checkReadiness();
      }),
    );
  });

  onCleanup(() => {
    clearResetTimer();
    for (const unlisten of unlisteners) unlisten();
  });

  const handleClick = async () => {
    const s = status();
    if (s === "syncing") return;
    if (s === "needs-setup") {
      navigate(ROUTES.SETTINGS);
      return;
    }

    showPersistent("syncing", "Syncing...");
    try {
      await typedInvoke("sync_start");
      // 結果表示は sync-complete / sync-error イベント側で行う
    } catch (e) {
      applyError(e);
    }
  };

  const iconName = (): IconName => {
    switch (status()) {
      case "syncing":
        return "cloud-arrow-up";
      case "error":
        return "cloud-warning";
      case "needs-setup":
        return "cloud-slash";
      default:
        return "cloud-check";
    }
  };

  const tooltip = () => {
    switch (status()) {
      case "error":
        return `${message()} — click to retry`;
      case "syncing":
        return "Syncing...";
      default:
        return message() || "Sync now";
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        aria-label={tooltip()}
        title={tooltip()}
        class="sync-button"
        classList={{
          syncing: status() === "syncing",
          error: status() === "error",
          success: status() === "success",
          "needs-setup": status() === "needs-setup",
        }}
      >
        <Icon name={iconName()} size={18} />
      </button>
      <Show when={message()}>
        <div
          class="sync-toast"
          data-status={status()}
          role="status"
          onClick={() => {
            if (status() !== "syncing") setMessage("");
          }}
        >
          {message()}
        </div>
      </Show>
    </>
  );
}
