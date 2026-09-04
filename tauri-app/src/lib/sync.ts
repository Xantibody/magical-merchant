import { createSignal, onMount, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { onLocalMutation, typedInvoke } from "./commands";
import { EVENTS } from "./events";
import { t } from "./i18n";
import { describeSyncError, describeSyncResult, syncErrorKind } from "./sync-status";
import type { SyncResultPayload } from "./sync-status";
import type { IconName } from "../components/Icon";

export type SyncStatus = "idle" | "syncing" | "success" | "error" | "needs-setup";

/** 自動保存 (1秒 debounce) の連打をまとめてから同期する。 */
export const AUTO_SYNC_DEBOUNCE_MS = 5000;

export interface SyncState {
  status: Accessor<SyncStatus>;
  message: Accessor<string>;
  lastSyncedAt: Accessor<Date | null>;
  autoSync: Accessor<boolean>;
  setAutoSync: (on: boolean) => Promise<void>;
  syncNow: () => Promise<void>;
  /** エラー時に自動で開くための合図。増えたら開く。 */
  alertVersion: Accessor<number>;
}

export function syncIconName(status: SyncStatus): IconName {
  switch (status) {
    case "syncing": {
      return "cloud-arrow-up";
    }
    case "error": {
      return "cloud-warning";
    }
    case "needs-setup": {
      return "cloud-slash";
    }
    default: {
      return "cloud-check";
    }
  }
}

/** 「2分前」。秒単位は同期直後にちらつくだけなので出さない。 */
export function formatRelativeTime(from: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - from.getTime()) / 60_000);
  if (minutes < 1) {
    return t().sync.justNow;
  }
  if (minutes < 60) {
    return t().sync.minutesAgo(minutes);
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return t().sync.hoursAgo(hours);
  }
  return t().sync.daysAgo(Math.floor(hours / 24));
}

export function createSyncState(onSynced: () => void): SyncState {
  const [status, setStatus] = createSignal<SyncStatus>("idle");
  const [message, setMessage] = createSignal("");
  const [lastSyncedAt, setLastSyncedAt] = createSignal<Date | null>(null);
  const [autoSync, setAutoSyncSignal] = createSignal(false);
  const [alertVersion, setAlertVersion] = createSignal(0);

  const unlisteners: UnlistenFn[] = [];

  const checkReadiness = async (): Promise<void> => {
    try {
      const config = await typedInvoke("get_sync_config");
      setAutoSyncSignal(config.auto_sync);
      if (!config.workers_url) {
        setStatus("needs-setup");
        setMessage(t().sync.notConfigured);
        return;
      }
      if (!(await typedInvoke("auth_status"))) {
        setStatus("needs-setup");
        setMessage(t().sync.notSignedIn);
        return;
      }
      setStatus("idle");
      setMessage("");
    } catch (error) {
      // 壊れた設定を「未設定」と見せると、設定画面で入力し直させることになり、
      // その保存が読めなかったファイルを上書きする
      if (syncErrorKind(error) === "configCorrupt") {
        setStatus("error");
        setMessage(t().sync.configCorrupt);
        return;
      }
      setStatus("needs-setup");
      setMessage(t().sync.notConfigured);
    }
  };

  // busy で取り直すのは 1 巡につき 1 回だけ。相手がロックを握ったまま
  // 止まっていることもあり、無条件に取り直すと延々と叩き続ける
  let busyRetried = false;

  const applyError = (err: unknown): void => {
    const ui = describeSyncError(err);
    setStatus(ui.status);
    setMessage(ui.message);

    // 別プロセスが同期中だっただけ。ここで捨てると、保存したぶんが
    // 次に手で同期するまで送られない
    if (syncErrorKind(err) === "busy") {
      if (!busyRetried) {
        busyRetried = true;
        // applyError → scheduleAutoSync → syncNow → applyError と輪になって
        // いるので、どこか 1 つは定義より前から呼ぶしかない
        // oxlint-disable-next-line no-use-before-define
        scheduleAutoSync();
      }
      return;
    }

    // 待機に戻るだけの結果でポップオーバーを開かない
    if (ui.status === "error" || ui.status === "needs-setup") {
      setAlertVersion((v) => v + 1);
    }
  };

  const syncNow = async (): Promise<void> => {
    if (status() === "syncing") {
      return;
    }
    setStatus("syncing");
    setMessage(t().sync.syncing);
    try {
      await typedInvoke("sync_start");
      // 結果は sync-complete / sync-error イベントで反映する
    } catch (error) {
      applyError(error);
    }
  };

  let autoSyncTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleAutoSync = (): void => {
    if (!autoSync() || status() === "needs-setup") {
      return;
    }
    if (autoSyncTimer) {
      clearTimeout(autoSyncTimer);
    }
    autoSyncTimer = setTimeout(() => {
      void syncNow();
    }, AUTO_SYNC_DEBOUNCE_MS);
  };

  onMount(async () => {
    await checkReadiness();

    unlisteners.push(
      onLocalMutation(scheduleAutoSync),
      await listen<SyncResultPayload>(EVENTS.SYNC_COMPLETE, (e) => {
        const ui = describeSyncResult(e.payload);
        setStatus(ui.status);
        setMessage(ui.message);
        if (ui.status === "success") {
          // 1 巡終わったので、次に busy を踏んだらまた取り直してよい
          busyRetried = false;
          setLastSyncedAt(new Date());
          onSynced();
        } else {
          setAlertVersion((v) => v + 1);
        }
      }),
      await listen<unknown>(EVENTS.SYNC_ERROR, (e) => applyError(e.payload)),
      await listen(EVENTS.AUTH_SUCCESS, () => {
        void checkReadiness();
      }),
    );
  });

  onCleanup(() => {
    if (autoSyncTimer) {
      clearTimeout(autoSyncTimer);
    }
    for (const unlisten of unlisteners) {
      unlisten();
    }
  });

  const setAutoSync = async (on: boolean): Promise<void> => {
    setAutoSyncSignal(on);
    try {
      const config = await typedInvoke("get_sync_config");
      await typedInvoke("save_sync_config", { config: { ...config, auto_sync: on } });
    } catch {
      // 保存できなければ画面上の状態も戻す
      setAutoSyncSignal(!on);
    }
  };

  return { status, message, lastSyncedAt, autoSync, setAutoSync, syncNow, alertVersion };
}
