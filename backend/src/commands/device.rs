//! Where a record was written, worded for reading.

use magical_merchant_core::domain::device::place_names;
use tauri::{AppHandle, Runtime};

use crate::services::geocoder::geocode;
use crate::services::tauri::{app_base_dir, off_main_thread};

/// Turns coordinates into place names.
///
/// Only the ones that resolved come back, keyed by `"latitude,longitude"`.
///
/// The record keeps the coordinates. What comes back is a rewording for reading, so
/// when a coordinate that did not resolve is missing, the caller can just print the
/// coordinates.
///
/// It is `async` because it must not run on the main thread. Synchronous commands
/// run on the main thread, and the geocoder's answer is queued on the main queue as
/// well. Waiting there blocks its own reply and always times out.
#[tauri::command]
pub(crate) async fn resolve_places<R: Runtime>(
    handle: AppHandle<R>,
    coordinates: Vec<(f64, f64)>,
    locale: String,
) -> Result<Vec<(String, String)>, String> {
    let base_dir = app_base_dir(&handle)?;
    off_main_thread(move || {
        Ok(place_names::resolve(
            &base_dir,
            &coordinates,
            &locale,
            geocode,
        ))
    })
    .await
}
