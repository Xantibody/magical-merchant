//! Sync with the Worker: the local tree under `data/` against the server's state in R2.
//!
//! The Worker owns the state; a client never uploads its own. The app and the CLI's
//! `sync` run the same rounds, and only one of them at a time.

pub mod conflict_copy;
pub mod diff;
mod result;
pub mod scan;
pub mod state;

// Only the parts that speak HTTP sit behind the feature. The Android JNI build and the
// MCP-only CLI need neither reqwest nor keyring, so the default does not pull them in.
#[cfg(feature = "sync-client")]
pub mod rounds;
#[cfg(feature = "sync-client")]
pub mod run;
#[cfg(feature = "sync-client")]
pub mod settings;

pub use result::{SyncIssue, SyncResult};
