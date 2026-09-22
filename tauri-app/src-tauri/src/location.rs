//! Location on macOS.
//!
//! `tauri-plugin-geolocation` is a stub on desktop and returns
//! `Position::default()` as is. It does not even ask for permission, so records
//! written on a Mac never carried coordinates. Call `CoreLocation` directly.

use std::cell::OnceCell;
use std::sync::Mutex;
use std::time::Duration;

use magical_merchant_core::utils::device::Location;
use objc2::rc::Retained;
use objc2_core_location::{CLLocationManager, kCLLocationAccuracyHundredMeters};
use tauri::AppHandle;

/// The most recent fix.
///
/// `CLLocationManager` is bound to the main thread and is not `Send`, so the
/// recording side talks to it through this slot.
static LAST_FIX: Mutex<Option<Location>> = Mutex::new(None);

/// How far the device must move before the next update arrives.
///
/// Knowing where a record was written is enough; there is no need to pin down the
/// street address. A finer filter only keeps the GPS running longer and adds
/// nothing to reading records back.
const DISTANCE_FILTER_METERS: f64 = 50.0;

/// How often the coordinates are copied into the slot.
///
/// The OS already thins the updates by distance, so this interval only changes how
/// stale the local copy can become. The first record after startup should carry
/// coordinates too, so it does not stretch to minutes.
const POLL_INTERVAL: Duration = Duration::from_secs(10);

thread_local! {
    /// Only the main thread touches this. Dropping it silently stops updates, so hold it.
    static MANAGER: OnceCell<Retained<CLLocationManager>> = const { OnceCell::new() };
}

/// Copies the coordinates known right now into the slot, on the main thread.
///
/// # Panics
///
/// It does not. Without permission `location` returns `None` and this returns too.
fn refresh() {
    MANAGER.with(|cell| {
        let manager = cell.get_or_init(|| {
            // SAFETY: only called inside run_on_main_thread. CoreLocation returns
            // results to the run loop of the thread that initialised it, so the
            // manager must be created on the main thread, where Tauri's event loop
            // runs.
            unsafe {
                let manager = CLLocationManager::new();
                manager.setDesiredAccuracy(kCLLocationAccuracyHundredMeters);
                manager.setDistanceFilter(DISTANCE_FILTER_METERS);
                manager.requestWhenInUseAuthorization();
                manager.startUpdatingLocation();
                manager
            }
        });

        // SAFETY: as above. Returns None until the first fix.
        let Some(fix) = (unsafe { manager.location() }) else {
            return;
        };
        // SAFETY: as above.
        let coordinate = unsafe { fix.coordinate() };
        // SAFETY: as above. A failed fix comes back as out-of-range coordinates.
        if !unsafe { coordinate.is_valid() } {
            return;
        }

        if let Ok(mut last) = LAST_FIX.lock() {
            *last = Some(Location {
                latitude: coordinate.latitude,
                longitude: coordinate.longitude,
            });
        }
    });
}

/// The coordinates to put on a record, or `None` before the first fix.
pub(crate) fn latest() -> Option<Location> {
    LAST_FIX.lock().ok().and_then(|fix| fix.clone())
}

/// Starts receiving location updates.
///
/// Waiting for the main thread on every save hangs when the waiter is the main
/// thread itself. Keep copying in the background so a save only reads the slot.
pub(crate) fn start(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        // This fails once the app is shut down. Nothing left to follow, so stop.
        while handle.run_on_main_thread(refresh).is_ok() {
            std::thread::sleep(POLL_INTERVAL);
        }
    });
}
