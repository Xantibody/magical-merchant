//! Looks a place name up from coordinates.
//!
//! What the record keeps is the coordinates; this is a rewording used only for reading.
//! The OS geocoder does the asking (`services::geocoder`); what stays here is the cache.

use magical_merchant_core::domain::device::{cache_key, place_key, place_names};
use std::path::Path;

use crate::services::geocoder::geocode;

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
    let mut cache = place_names::load(base_dir);
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
        let _ = place_names::save(base_dir, &cache);
    }
    resolved
}
