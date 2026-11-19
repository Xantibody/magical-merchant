//! Looks a place name up from coordinates.
//!
//! What the record keeps is the coordinates; this is a rewording used only for reading.
//! The OS geocoder does the asking (`services::geocoder`); what stays here is the cache.

use magical_merchant_core::domain::device::{cache_key, place_key, place_names};
use std::path::Path;

use crate::services::geocoder::geocode;

/// [`resolve_with`] asking the OS geocoder.
pub(crate) fn resolve(
    base_dir: &Path,
    coordinates: &[(f64, f64)],
    locale: &str,
) -> Vec<(String, String)> {
    resolve_with(base_dir, coordinates, locale, geocode)
}

/// Returns only the coordinates whose place name is known, each with its [`place_key`].
///
/// A coordinate that could not be resolved does not appear in the result. The caller shows
/// it as coordinates.
///
/// `locale` is the language the UI uses right now (`ja` / `en`). The OS returns a different
/// name per language, so the cache is kept per language as well. `geocode` is what asks for
/// a name the cache does not have.
pub(crate) fn resolve_with(
    base_dir: &Path,
    coordinates: &[(f64, f64)],
    locale: &str,
    mut geocode: impl FnMut(f64, f64, &str) -> Option<String>,
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

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use magical_merchant_core::domain::device::PlaceCache;
    use tempfile::TempDir;

    use super::*;

    /// A geocoder that answers from a list and writes down every coordinate it was asked.
    struct FakeGeocoder {
        answers: Vec<Option<&'static str>>,
        asked: RefCell<Vec<(f64, f64, String)>>,
    }

    impl FakeGeocoder {
        fn answering(answers: &[Option<&'static str>]) -> Self {
            Self {
                answers: answers.to_vec(),
                asked: RefCell::new(Vec::new()),
            }
        }

        fn geocode(&self, latitude: f64, longitude: f64, locale: &str) -> Option<String> {
            let mut asked = self.asked.borrow_mut();
            let answer = self.answers.get(asked.len()).copied().flatten();
            asked.push((latitude, longitude, locale.to_string()));
            answer.map(str::to_string)
        }

        fn asked(&self) -> Vec<(f64, f64, String)> {
            self.asked.borrow().clone()
        }
    }

    fn resolve_through(
        base_dir: &Path,
        coordinates: &[(f64, f64)],
        geocoder: &FakeGeocoder,
    ) -> Vec<(String, String)> {
        resolve_with(base_dir, coordinates, "ja", |lat, lon, locale| {
            geocoder.geocode(lat, lon, locale)
        })
    }

    /// A name already known in this language is not asked again.
    #[test]
    fn a_cached_coordinate_is_not_asked() {
        let tmp = TempDir::new().unwrap();
        let mut cache = PlaceCache::default();
        cache.insert(cache_key("ja", "35.68,139.55"), "渋谷区".to_string());
        place_names::save(tmp.path(), &cache).unwrap();
        let geocoder = FakeGeocoder::answering(&[Some("新宿区")]);

        let resolved = resolve_through(tmp.path(), &[(35.681, 139.551)], &geocoder);

        assert_eq!(
            resolved,
            [("35.68,139.55".to_string(), "渋谷区".to_string())]
        );
        assert!(geocoder.asked().is_empty());
    }

    /// Two coordinates in one cell are one place: asked once, answered once.
    #[test]
    fn coordinates_of_one_place_come_back_once() {
        let tmp = TempDir::new().unwrap();
        let geocoder = FakeGeocoder::answering(&[Some("渋谷区"), Some("新宿区")]);

        let resolved = resolve_through(
            tmp.path(),
            &[(35.681, 139.551), (35.684, 139.554)],
            &geocoder,
        );

        assert_eq!(
            resolved,
            [("35.68,139.55".to_string(), "渋谷区".to_string())]
        );
        assert_eq!(geocoder.asked().len(), 1);
    }

    /// Off the network every lookup fails; the first failure stops the asking.
    #[test]
    fn the_first_failure_stops_the_asking() {
        let tmp = TempDir::new().unwrap();
        let geocoder = FakeGeocoder::answering(&[None, Some("新宿区")]);

        let resolved = resolve_through(tmp.path(), &[(35.68, 139.55), (35.69, 139.70)], &geocoder);

        assert!(resolved.is_empty());
        assert_eq!(geocoder.asked().len(), 1);
    }

    /// Nothing new was learned, so the cache file is left as it was: here, absent.
    #[test]
    fn nothing_asked_writes_no_cache() {
        let tmp = TempDir::new().unwrap();
        let geocoder = FakeGeocoder::answering(&[None]);

        resolve_through(tmp.path(), &[(35.68, 139.55)], &geocoder);
        resolve_through(tmp.path(), &[], &geocoder);

        assert!(!tmp.path().join("places.json").exists());
    }

    /// The answer is keyed by the coordinates alone, which the screen looks up; the language
    /// stays inside the cache.
    #[test]
    fn the_answer_is_keyed_without_the_language() {
        let tmp = TempDir::new().unwrap();
        let geocoder = FakeGeocoder::answering(&[Some("渋谷区")]);

        let resolved = resolve_through(tmp.path(), &[(35.681, 139.551)], &geocoder);

        assert_eq!(resolved[0].0, place_key(35.681, 139.551));
        assert_eq!(geocoder.asked()[0].2, "ja");
        assert_eq!(
            place_names::load(tmp.path()).get(&cache_key("ja", "35.68,139.55")),
            Some("渋谷区")
        );
    }
}
