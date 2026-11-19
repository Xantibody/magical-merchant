// Only the parts that speak HTTP sit behind the feature. The Android JNI build and the
// MCP-only CLI need neither reqwest nor keyring, so the default does not pull them in.
#[cfg(feature = "sync-client")]
pub mod config;
#[cfg(feature = "sync-client")]
pub mod engine;
#[cfg(feature = "sync-client")]
pub mod lock;
#[cfg(feature = "sync-client")]
pub mod token;

pub use crate::domain::sync::{SyncIssue, SyncResult};
