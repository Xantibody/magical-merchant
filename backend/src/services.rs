//! Code that talks to one outside party and only communicates, named after the party.

#[cfg(target_os = "android")]
pub(crate) mod android;
#[cfg(target_os = "android")]
pub(crate) mod android_tls;
pub(crate) mod core_location;
pub(crate) mod geocoder;
#[cfg(not(target_os = "android"))]
pub(crate) mod loopback;
pub(crate) mod tauri;
pub(crate) mod widgets;
pub(crate) mod windows;
