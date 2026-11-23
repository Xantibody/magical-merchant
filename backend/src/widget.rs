//! Entry: the Android home screen widget, which calls in through JNI.

#[cfg(target_os = "android")]
pub mod bridge;
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
mod summary;
