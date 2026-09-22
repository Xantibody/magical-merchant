//! Looks a place name up from coordinates.
//!
//! What the record keeps is the coordinates; this is a rewording used only for reading.
//! The municipality is enough, so the street number and the building name are dropped and
//! the answer falls back to the wider administrative area.
//!
//! No place-name data of our own ships with the app. A dictionary of a few MB would only be
//! a worse copy of what the OS already has, and an address is worded differently by country.

use magical_merchant_core::utils::paths::place_cache_path;
use magical_merchant_core::utils::place::{PlaceCache, cache_key, place_key};
use std::path::Path;

/// Returns only the coordinates whose place name is known, each with its [`place_key`].
///
/// A coordinate that could not be resolved does not appear in the result. The caller shows
/// it as coordinates.
///
/// `locale` is the language the UI uses right now (`ja` / `en`). The OS returns a different
/// name per language, so the cache is kept per language as well.
pub(crate) fn resolve(
    base_dir: &Path,
    coordinates: &[(f64, f64)],
    locale: &str,
) -> Vec<(String, String)> {
    let path = place_cache_path(base_dir);
    let mut cache = PlaceCache::load(&path);
    let mut resolved = Vec::new();
    let mut asked = false;

    for &(latitude, longitude) in coordinates {
        let key = place_key(latitude, longitude);
        if resolved.iter().any(|(k, _): &(String, String)| *k == key) {
            continue;
        }
        // What is returned is the coordinates-only key. That is what the UI looks up, and
        // mixing the language in is kept inside the cache
        let cached = cache_key(locale, &key);
        if let Some(place) = cache.get(&cached) {
            resolved.push((key, place.to_string()));
            continue;
        }
        // Off the network they all fail. Do not put 30 coordinates through what the first
        // one already showed.
        let Some(place) = geocode(latitude, longitude, locale) else {
            break;
        };
        cache.insert(cached, place.clone());
        asked = true;
        resolved.push((key, place));
    }

    if asked {
        // The names that were resolved are returned even if the write fails. The cost is
        // only asking again the next time it is opened.
        let _ = cache.save(&path);
    }
    resolved
}

/// Picks the finest address level that can still be pointed at on a map.
///
/// Municipality, then county, then prefecture or state, then country. It falls back upward
/// so that land with no municipality does not come out empty.
///
/// On Linux, which has no geocoder, nothing calls this, but the build runs on every OS:
/// CI runs on Linux, and which level is picked is the part the tests here check.
#[cfg_attr(not(any(target_os = "macos", target_os = "android")), allow(dead_code))]
fn coarsest_name(
    locality: Option<String>,
    sub_administrative_area: Option<String>,
    administrative_area: Option<String>,
    country: Option<String>,
) -> Option<String> {
    [
        locality,
        sub_administrative_area,
        administrative_area,
        country,
    ]
    .into_iter()
    .flatten()
    .find(|name| !name.trim().is_empty())
}

#[cfg(target_os = "macos")]
mod platform {
    //! The macOS 26 SDK deprecates `CLGeocoder` and points at `MapKit`.
    //!
    //! We do not move over because `MapKit` drags in the whole map-drawing framework.
    //! Stacking a UI framework does not balance against one place-name lookup that does not
    //! even want the street number. If it goes away only the lookup goes: the display falls
    //! back to coordinates and no record is lost.
    #![allow(deprecated)]

    use super::coarsest_name;
    use block2::RcBlock;
    use objc2::AnyThread as _;
    use objc2_core_location::{CLGeocoder, CLLocation, CLPlacemark};
    use objc2_foundation::{NSArray, NSError, NSLocale, NSString};
    use std::sync::mpsc;
    use std::time::Duration;

    /// Cap on waiting for the geocoder to answer.
    ///
    /// `CLGeocoder` does not give up at once when off the network, and the IPC does not
    /// return for as long as it waits. Measured, one lookup is under 100ms, so this is used
    /// up only when the name cannot be resolved. Showing the coordinates as they are is
    /// ready, so give up before waiting.
    const TIMEOUT: Duration = Duration::from_secs(8);

    /// # Panics
    ///
    /// It does not. If no answer arrives it times out and returns `None`.
    ///
    /// Do not call this from the main thread. `CLGeocoder` puts the completion block on the
    /// main queue, so waiting there blocks its own answer and the timeout always fires.
    /// That is why the caller `resolve_places` is `async`.
    pub(super) fn geocode(latitude: f64, longitude: f64, locale: &str) -> Option<String> {
        // SAFETY: both are plain object creations and carry no thread constraint.
        let (location, geocoder) = unsafe {
            (
                CLLocation::initWithLatitude_longitude(CLLocation::alloc(), latitude, longitude),
                CLGeocoder::new(),
            )
        };
        // Without a language it comes back in the OS setting. With an English UI only the
        // place name would be Japanese
        let preferred = NSLocale::localeWithLocaleIdentifier(&NSString::from_str(locale));
        let (tx, rx) = mpsc::channel();

        // The block holds the geocoder itself, keeping it alive until the answer arrives.
        let held = geocoder.clone();
        let handler = RcBlock::new(
            move |placemarks: *mut NSArray<CLPlacemark>, _: *mut NSError| {
                let _ = &held;
                // SAFETY: what CoreLocation hands over is its own and stays alive until
                // the block returns. The address levels are read only within that window.
                let name = unsafe {
                    placemarks
                        .as_ref()
                        .and_then(NSArray::firstObject)
                        .and_then(|mark| {
                            coarsest_name(
                                mark.locality().map(|s| s.to_string()),
                                mark.subAdministrativeArea().map(|s| s.to_string()),
                                mark.administrativeArea().map(|s| s.to_string()),
                                mark.country().map(|s| s.to_string()),
                            )
                        })
                };
                let _ = tx.send(name);
            },
        );

        // SAFETY: this only hands over the completion block. CLGeocoder copies the block it
        // receives and holds it, so the callee lives on even when a timeout drops ours.
        unsafe {
            geocoder.reverseGeocodeLocation_preferredLocale_completionHandler(
                &location,
                Some(&preferred),
                RcBlock::as_ptr(&handler),
            );
        }

        rx.recv_timeout(TIMEOUT).ok().flatten()
    }
}

#[cfg(target_os = "android")]
mod platform {
    use super::coarsest_name;
    use jni::objects::{JObject, JString, JValue};
    use jni::strings::JNIStr;
    use jni::{Env, jni_sig, jni_str};

    /// `Geocoder` is tied to the device Context, so it cannot be built bare from Rust.
    /// It borrows the VM and Application Context taken at startup and calls into Java.
    pub(super) fn geocode(latitude: f64, longitude: f64, locale: &str) -> Option<String> {
        // The attach in jni 0.22 exposes `Env` only inside the closure. The borrowed
        // lifetime is pinned to one stretch of the stack and cannot escape after detach
        crate::android_context::with_context(|env, context| {
            let name = lookup(env, &context, latitude, longitude, locale);
            if name.is_none() {
                // Off the network `getFromLocation` throws IOException. Left pending, an
                // unrelated call fails at the next crossing of JNI.
                let _ = env.exception_clear();
            }
            Ok(name)
        })?
        .ok()
        .flatten()
    }

    fn lookup(
        env: &mut Env<'_>,
        context: &JObject<'_>,
        latitude: f64,
        longitude: f64,
        language: &str,
    ) -> Option<String> {
        // Ask in the UI language, not the device default. With `Locale.getDefault()`, only
        // the place name comes back in the device language inside an app set to English
        let tag = env.new_string(language).ok()?;
        let locale = env
            .new_object(
                jni_str!("java/util/Locale"),
                jni_sig!((tag: java.lang.String) -> void),
                &[JValue::Object(&tag)],
            )
            .ok()?;
        let geocoder = env
            .new_object(
                jni_str!("android/location/Geocoder"),
                jni_sig!((context: android.content.Context, locale: java.util.Locale) -> void),
                &[JValue::Object(context), JValue::Object(&locale)],
            )
            .ok()?;

        // Ask for one only. Anything after it is just another wording of the same place.
        let addresses = env
            .call_method(
                &geocoder,
                jni_str!("getFromLocation"),
                jni_sig!((latitude: double, longitude: double, max: int) -> java.util.List),
                &[
                    JValue::Double(latitude),
                    JValue::Double(longitude),
                    JValue::Int(1),
                ],
            )
            .ok()?
            .l()
            .ok()?;
        if addresses.is_null()
            || env
                .call_method(&addresses, jni_str!("size"), jni_sig!(() -> int), &[])
                .ok()?
                .i()
                .ok()?
                == 0
        {
            return None;
        }
        let address = env
            .call_method(
                &addresses,
                jni_str!("get"),
                jni_sig!((index: int) -> java.lang.Object),
                &[JValue::Int(0)],
            )
            .ok()?
            .l()
            .ok()?;

        coarsest_name(
            string_getter(env, &address, jni_str!("getLocality")),
            string_getter(env, &address, jni_str!("getSubAdminArea")),
            string_getter(env, &address, jni_str!("getAdminArea")),
            string_getter(env, &address, jni_str!("getCountryName")),
        )
    }

    /// An `Address` getter returns null when that level is absent.
    fn string_getter(env: &mut Env<'_>, address: &JObject<'_>, name: &JNIStr) -> Option<String> {
        let value = env
            .call_method(address, name, jni_sig!(() -> java.lang.String), &[])
            .ok()?
            .l()
            .ok()?;
        if value.is_null() {
            return None;
        }
        let text = env.cast_local::<JString<'_>>(value).ok()?;
        text.try_to_string(env).ok()
    }
}

/// Windows and Linux have no reverse geocoder that can be called without an extra
/// dependency. Showing the coordinates as they are is still open, so this gives up quietly.
#[cfg(not(any(target_os = "macos", target_os = "android")))]
mod platform {
    pub(super) const fn geocode(_latitude: f64, _longitude: f64, _locale: &str) -> Option<String> {
        None
    }
}

use platform::geocode;

#[cfg(test)]
mod tests {
    use super::*;

    /// The four address levels, with an absent level given as `""`. A level the geocoder
    /// returns empty and one it does not return at all both count as "unnamed".
    fn named(areas: [&str; 4]) -> Option<String> {
        let [locality, sub, admin, country] =
            areas.map(|area| (!area.is_empty()).then(|| area.to_string()));
        coarsest_name(locality, sub, admin, country)
    }

    #[test]
    fn a_municipality_beats_the_wider_areas_around_it() {
        assert_eq!(
            named(["渋谷区", "東京都", "東京都", "日本"]).as_deref(),
            Some("渋谷区")
        );
    }

    /// Land with no municipality returns only a county or a state. Giving up there leaves
    /// the record with no way to say where it was.
    #[test]
    fn it_falls_back_through_the_wider_areas() {
        assert_eq!(
            named(["", "上川郡", "北海道", "日本"]).as_deref(),
            Some("上川郡")
        );
        assert_eq!(named(["", "", "北海道", "日本"]).as_deref(), Some("北海道"));
        assert_eq!(named(["", "", "", "日本"]).as_deref(), Some("日本"));
    }

    /// The geocoder sometimes returns a level it does not know as a whitespace-only string.
    /// A blank label is less useful than the coordinates.
    #[test]
    fn a_blank_name_counts_as_missing() {
        assert_eq!(named(["  ", "", "北海道", ""]).as_deref(), Some("北海道"));
    }

    #[test]
    fn a_coordinate_no_one_can_name_stays_unnamed() {
        assert_eq!(named(["", "", "", ""]), None);
    }
}
