export const EVENTS = {
  SYNC_COMPLETE: "sync-complete",
  SYNC_ERROR: "sync-error",
  AUTH_SUCCESS: "auth-success",
  AUTH_ERROR: "auth-error",
  /** Something under `data/` changed on disk (`src-tauri/src/watch.rs`, desktop only). */
  DATA_CHANGED: "data-changed",
} as const;
