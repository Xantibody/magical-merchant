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

export type SyncStatus = "idle" | "syncing" | "success" | "error" | "needs-setup" | "signed-out";

/** Gather up a burst of autosaves (1s debounce) before syncing. */
export const AUTO_SYNC_DEBOUNCE_MS = 5000;

/**
 * The least time between two syncs started by coming back to the app. Desktop reports every
 * focus change, and switching windows every few seconds must not become a sync each time.
 */
export const RESUME_SYNC_INTERVAL_MS = 60_000;

export interface SyncState {
  status: Accessor<SyncStatus>;
  message: Accessor<string>;
  lastSyncedAt: Accessor<Date | null>;
  autoSync: Accessor<boolean>;
  setAutoSync: (on: boolean) => Promise<void>;
  syncNow: () => Promise<void>;
  syncOnStart: Accessor<boolean>;
  setSyncOnStart: (on: boolean) => Promise<void>;
  /** The app came back to the foreground. Syncs when the setting asks for it. */
  resume: () => void;
  /** The user is leaving the app. Syncs at once if something was saved since the last round. */
  leave: () => void;
  /** The signal to open automatically on an error. It opens when this goes up. */
  alertVersion: Accessor<number>;
}

export function syncIconName(status: SyncStatus): IconName {
  switch (status) {
    case "syncing": {
      return "cloud-arrow-up";
    }
    case "error":
    case "signed-out": {
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
  const [syncOnStart, setSyncOnStartSignal] = createSignal(false);
  const [alertVersion, setAlertVersion] = createSignal(0);

  const unlisteners: UnlistenFn[] = [];

  /** Not set up, or set up without a login: a round could only fail. */
  const cannotSync = (): boolean => status() === "needs-setup" || status() === "signed-out";

  /**
   * The login is gone: found out at launch, on a return, or from a round the server refused.
   * The popover opens once per episode, on the way in. Every return on desktop is a focus
   * change, and reopening on each would be nagging; the icon carries the warning in between.
   * A device with both switches off syncs by hand and meets the refusal there, so it is not told
   */
  const enterSignedOut = (text: string): void => {
    const fresh = status() !== "signed-out";
    setStatus("signed-out");
    setMessage(text);
    if (fresh && (autoSync() || syncOnStart())) {
      setAlertVersion((v) => v + 1);
    }
  };

  const checkReadiness = async (): Promise<void> => {
    try {
      const config = await typedInvoke("get_sync_config");
      setAutoSyncSignal(config.auto_sync);
      setSyncOnStartSignal(config.sync_on_start);
      if (!config.workers_url) {
        setStatus("needs-setup");
        setMessage(t().sync.notConfigured);
        return;
      }
      if (!(await typedInvoke("auth_status"))) {
        enterSignedOut(t().sync.notSignedIn);
        return;
      }
      // Ready. What the last round said (success, error) stays on show; only a block is lifted
      if (cannotSync()) {
        setStatus("idle");
        setMessage("");
      }
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
    if (ui.status === "signed-out") {
      enterSignedOut(ui.message);
      return;
    }
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

  // When the last round started, whatever started it. `resume` counts its interval from here
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  // When something was last written on this device, or -Infinity once a round that started
  // after it has finished. While it is newer than the last round's start, the device holds
  // something unsent: a leave syncs at once, and a return does not wait out its interval
  let dirtiedAt = Number.NEGATIVE_INFINITY;
  const dirty = (): boolean => dirtiedAt > lastStartedAt;

  // A sync asked for while one is running. Dropping it lost whatever was saved during the
  // round until the next save or return, and leaving the app has no next save. Several
  // asks fold into one more round, run when the current one ends
  let rerunRequested = false;

  const roundEnded = (): void => {
    if (rerunRequested) {
      rerunRequested = false;
      // syncNow and roundEnded call each other, so one is named before it is defined
      // oxlint-disable-next-line no-use-before-define
      void syncNow();
    }
  };

  const syncNow = async (): Promise<void> => {
    if (status() === "syncing") {
      rerunRequested = true;
      return;
    }
    lastStartedAt = Date.now();
    setStatus("syncing");
    setMessage(t().sync.syncing);
    try {
      await typedInvoke("sync_start");
      // The result is applied through the sync-complete / sync-error events
    } catch (error) {
      applyError(error);
      roundEnded();
    }
  };

  let autoSyncTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleAutoSync = (): void => {
    if (!autoSync() || cannotSync()) {
      return;
    }
    if (autoSyncTimer) {
      clearTimeout(autoSyncTimer);
    }
    autoSyncTimer = setTimeout(() => {
      void syncNow();
    }, AUTO_SYNC_DEBOUNCE_MS);
  };

  /**
   * The sync a start or a return brings: at once when something is still unsent, since the
   * leave sync can be cut short by the OS and the return is its second chance; otherwise
   * when the setting asks for it and not too soon.
   */
  const syncIfAsked = (): void => {
    if (cannotSync()) {
      return;
    }
    if (dirty() && autoSync()) {
      void syncNow();
      return;
    }
    if (!syncOnStart()) {
      return;
    }
    if (Date.now() - lastStartedAt < RESUME_SYNC_INTERVAL_MS) {
      return;
    }
    void syncNow();
  };

  const resume = (): void => {
    void (async () => {
      // The login lasts days and runs out while the app is away. Nothing else looks at it
      // until a round fails, so the return is where it is looked at: two local calls, no
      // network, and no interval, unlike the sync. A round in flight proved it a moment ago
      if (status() !== "syncing") {
        await checkReadiness();
      }
      syncIfAsked();
    })();
  };

  // The timer after a save waits for the next keystroke. Leaving the app is the end of the
  // keystrokes, and on Android the process may be gone before the timer fires. Every switch
  // of window on desktop is a leave too, so it does nothing when nothing was saved
  const leave = (): void => {
    if (!autoSync() || cannotSync() || !dirty()) {
      return;
    }
    if (autoSyncTimer) {
      clearTimeout(autoSyncTimer);
      autoSyncTimer = undefined;
    }
    void syncNow();
  };

  onMount(async () => {
    await checkReadiness();

    unlisteners.push(
      onLocalMutation(() => {
        dirtiedAt = Date.now();
        scheduleAutoSync();
      }),
      await listen<SyncResultPayload>(EVENTS.SYNC_COMPLETE, (e) => {
        const ui = describeSyncResult(e.payload);
        setStatus(ui.status);
        setMessage(ui.message);
        if (ui.status === "success") {
          // A round finished, so hitting busy again may retry once more
          busyRetried = false;
          setLastSyncedAt(new Date());
          // A save that landed during the round is newer than its start and stays unsent
          if (!dirty()) {
            dirtiedAt = Number.NEGATIVE_INFINITY;
          }
          onSynced();
        } else {
          setAlertVersion((v) => v + 1);
        }
        roundEnded();
      }),
      await listen<unknown>(EVENTS.SYNC_ERROR, (e) => {
        applyError(e.payload);
        roundEnded();
      }),
      await listen(EVENTS.AUTH_SUCCESS, () => {
        void checkReadiness();
      }),
    );
    // Only now: a round started before the listeners are in place could end unheard
    syncIfAsked();
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

  const setSyncOnStart = async (on: boolean): Promise<void> => {
    setSyncOnStartSignal(on);
    try {
      const config = await typedInvoke("get_sync_config");
      await typedInvoke("save_sync_config", { config: { ...config, sync_on_start: on } });
    } catch {
      setSyncOnStartSignal(!on);
    }
  };

  return {
    status,
    message,
    lastSyncedAt,
    autoSync,
    setAutoSync,
    syncNow,
    syncOnStart,
    setSyncOnStart,
    resume,
    leave,
    alertVersion,
  };
}
