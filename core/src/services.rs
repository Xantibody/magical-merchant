//! Code that talks to one outside party each, named after the party. It only
//! communicates; the app's rules live in `domain`.

pub mod files;
// The Android JNI build and the MCP-only CLI need no HTTP, so reqwest stays behind the feature.
#[cfg(feature = "sync-client")]
pub mod worker;
