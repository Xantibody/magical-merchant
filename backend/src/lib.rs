// A panicking assertion is the point of a test; only production code has to
// prove it handles the error case.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
// `#[tauri::command]` arguments arrive by value: serde deserializes them out of
// the IPC payload, and `AppHandle` / `State` are injected owned. Borrowing them
// is not an option this crate has.
#![allow(clippy::needless_pass_by_value)]

mod app;
mod commands;
mod device;
mod links;
mod services;
#[cfg(desktop)]
mod shortcut;
#[cfg(test)]
mod test_app;
// Public because it is a real external surface: the JNI symbols in `widget::bridge`
// are what the Android widget links against, and `unreachable_pub` is right that a
// private module cannot hold one honestly. Built on every platform, though only the
// bridge reads `widget::summary`, so its tests run: CI has no Android target, and the
// parsing is the part worth testing.
pub mod widget;

pub use app::run;
