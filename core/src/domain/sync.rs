//! Sync with the Worker: the local tree under `data/` against the server's state in R2.
//!
//! The Worker owns the state; a client never uploads its own. The app and the CLI's
//! `sync` run the same rounds, and only one of them at a time.

mod result;

pub use result::{SyncIssue, SyncResult};
