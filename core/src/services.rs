//! Code that talks to one outside party each, named after the party. It only
//! communicates; the app's rules live in `domain`.

pub mod files;
// The keyring crate has no store on Android; the token lives in a file there.
#[cfg(all(feature = "sync-client", not(target_os = "android")))]
pub mod keyring;
// The Android JNI build and the MCP-only CLI need no HTTP, so reqwest stays behind the feature.
#[cfg(feature = "sync-client")]
pub mod worker;
