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

/** Gather up a burst of autosaves (1s debounce) before syncing. */
export const AUTO_SYNC_DEBOUNCE_MS = 5000;

export interface SyncState {
  status: Accessor<SyncStatus>;
  message: Accessor<string>;
  lastSyncedAt: Accessor<Date | null>;
  autoSync: Accessor<boolean>;
  setAutoSync: (on: boolean) => Promise<void>;
  syncNow: () => Promise<void>;
  /** The signal to open automatically on an error. It opens when this goes up. */
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

/** "2 minutes ago". Seconds only flicker right after a sync, so they are not shown. */
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
      // Showing a corrupt config as "not configured" would make the settings screen ask for
      // it again, and that save would overwrite the file that could not be read
      if (syncErrorKind(error) === "configCorrupt") {
        setStatus("error");
        setMessage(t().sync.configCorrupt);
        return;
      }
      setStatus("needs-setup");
      setMessage(t().sync.notConfigured);
    }
  };

  // A busy retry happens only once per round. The other side can be stuck holding the lock,
  // and retrying unconditionally would keep hammering it forever
  let busyRetried = false;

  const applyError = (err: unknown): void => {
    const ui = describeSyncError(err);
    setStatus(ui.status);
    setMessage(ui.message);

    // Another process was simply mid-sync. Dropping it here would leave what was saved
    // unsent until the next manual sync
    if (syncErrorKind(err) === "busy") {
      if (!busyRetried) {
        busyRetried = true;
        // applyError, scheduleAutoSync, syncNow and applyError form a ring, so one of them
        // has to be called from before its definition
        // oxlint-disable-next-line no-use-before-define
        scheduleAutoSync();
      }
      return;
    }

    // Do not open the popover for a result that only returns to idle
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
      // The result is applied through the sync-complete / sync-error events
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
          // A round finished, so hitting busy again may retry once more
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
      // If it cannot be saved, put the on-screen state back too
      setAutoSyncSignal(!on);
    }
  };

  return { status, message, lastSyncedAt, autoSync, setAutoSync, syncNow, alertVersion };
}
