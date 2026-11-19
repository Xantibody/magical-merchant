//! The place names asked once, kept in `places.json` beside `data/`.

use std::path::{Path, PathBuf};

use super::place::{PlaceCache, cache_key, place_key};
use crate::services::files;
use crate::utils::error::CoreError;

/// Returns only the coordinates whose place name is known, each with its [`place_key`].
///
/// A coordinate that could not be resolved does not appear in the result. The caller shows
/// it as coordinates.
///
/// `locale` is the language the UI uses right now (`ja` / `en`). The OS returns a different
/// name per language, so the cache is kept per language as well. `geocode` is what asks for
/// a name the cache does not have: the app passes the OS geocoder, a test a fake.
pub fn resolve<G>(
    base_dir: &Path,
    coordinates: &[(f64, f64)],
    locale: &str,
    mut geocode: G,
) -> Vec<(String, String)>
where
    G: FnMut(f64, f64, &str) -> Option<String>,
{
    let mut cache = load(base_dir);
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
        let _ = save(base_dir, &cache);
    }
    resolved
}

/// Where the place-name cache lives.
///
/// Outside `data/`. The content is only a derivative that can be looked up again
/// from coordinates; on sync, caches in a different language per device would just
/// travel back and forth.
fn path(base_dir: &Path) -> PathBuf {
    base_dir.join("places.json")
}

/// Starts empty if unreadable. It is only a derivative, so a broken one can be
/// rebuilt, and there is no reason to stop the reading side.
#[must_use]
pub fn load(base_dir: &Path) -> PlaceCache {
    files::read_if_present(&path(base_dir))
        .ok()
        .flatten()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

pub fn save(base_dir: &Path, cache: &PlaceCache) -> Result<(), CoreError> {
    let json =
        serde_json::to_string(cache).map_err(|e| CoreError::Parse(format!("place cache: {e}")))?;
    files::write_atomic(&path(base_dir), json)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use tempfile::TempDir;

    /// Only what is under `data/` syncs. A derivative cache sits outside it.
    #[test]
    fn the_place_cache_sits_outside_the_synced_tree() {
        assert_eq!(path(Path::new("/app")), PathBuf::from("/app/places.json"));
    }

    /// The sync walks `data/`. Saved there, each device's names in its own language
    /// would travel back and forth on every run.
    #[test]
    fn a_save_lands_beside_data_not_under_it() {
        let tmp = TempDir::new().unwrap();
        let mut cache = PlaceCache::default();
        cache.insert("35.68,139.55".to_string(), "渋谷区".to_string());

        save(tmp.path(), &cache).unwrap();

        assert!(tmp.path().join("places.json").is_file());
        assert!(!crate::domain::data::data_dir(tmp.path()).exists());
    }

    #[test]
    fn what_was_saved_survives_a_reload() {
        let tmp = TempDir::new().unwrap();
        let mut cache = PlaceCache::default();
        cache.insert("35.68,139.55".to_string(), "渋谷区".to_string());

        save(tmp.path(), &cache).unwrap();

        assert_eq!(load(tmp.path()).get("35.68,139.55"), Some("渋谷区"));
    }

    /// It is a derivative, so a broken one is simply asked again. Scrawl failing to
    /// open because it cannot be read would be the worse problem.
    #[test]
    fn an_unreadable_cache_starts_empty() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("places.json"), "{ not json").unwrap();

        assert!(load(tmp.path()).is_empty());
    }

    #[test]
    fn a_missing_cache_starts_empty() {
        let tmp = TempDir::new().unwrap();

        assert!(load(tmp.path()).is_empty());
    }

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
        resolve(base_dir, coordinates, "ja", |lat, lon, locale| {
            geocoder.geocode(lat, lon, locale)
        })
    }

    /// A name already known in this language is not asked again.
    #[test]
    fn a_cached_coordinate_is_not_asked() {
        let tmp = TempDir::new().unwrap();
        let mut cache = PlaceCache::default();
        cache.insert(cache_key("ja", "35.68,139.55"), "渋谷区".to_string());
        save(tmp.path(), &cache).unwrap();
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
            load(tmp.path()).get(&cache_key("ja", "35.68,139.55")),
            Some("渋谷区")
        );
    }
}
