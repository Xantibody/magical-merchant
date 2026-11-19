//! Code that talks to one outside party and only communicates, named after the party.

#[cfg(target_os = "android")]
pub(crate) mod android;
#[cfg(target_os = "android")]
pub(crate) mod android_tls;
#[cfg(target_os = "macos")]
pub(crate) mod core_location;
pub(crate) mod geocoder;
pub(crate) mod tauri;
pub(crate) mod widgets;
