//! Where the answers from turning coordinates into place names are kept.
//!
//! The conversion itself is left to the OS geocoder, so all that is here is "how
//! close counts as the same place" and "how an answer, once received, is kept".
//!
//! The recorded coordinates are never touched. A place name is only a coarse
//! paraphrase for reading; written back into the trailing JSON, the record of
//! where you were would be at the mercy of the geocoder.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::CoreError;
use crate::utils::fs::write_atomic;

/// Decimal digits the key is rounded to. 2 digits is roughly a 1.1km square.
///
/// Cutting finer than a municipality only returns the same place name and hits
/// the geocoder more. The coarser it is, the more one answer is reused.
const KEY_DIGITS: usize = 2;

/// A string for the group of coordinates treated as the same place.
#[must_use]
pub fn place_key(latitude: f64, longitude: f64) -> String {
    let digits = KEY_DIGITS;
    format!("{latitude:.digits$},{longitude:.digits$}")
}

/// Place names asked once. The key is [`place_key`].
///
/// Coordinates that could not be resolved are not remembered. Keeping a coordinate
/// that only failed for lack of signal as "no place name" would leave that one place
/// stuck as coordinates even after signal returns.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PlaceCache {
    places: BTreeMap<String, String>,
}

impl PlaceCache {
    /// Starts empty if unreadable. It is only a derivative, so a broken one can be
    /// rebuilt, and there is no reason to stop the reading side.
    #[must_use]
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<(), CoreError> {
        let json = serde_json::to_string(&self)
            .map_err(|e| CoreError::Parse(format!("place cache: {e}")))?;
        write_atomic(path, json)
    }

    #[must_use]
    pub fn get(&self, key: &str) -> Option<&str> {
        self.places.get(key).map(String::as_str)
    }

    pub fn insert(&mut self, key: String, place: String) {
        self.places.insert(key, place);
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.places.is_empty()
    }

    /// Looks up with a preferred language. If the preferred language has none, any
    /// other language; if that has none either, the cache written before languages
    /// were added.
    ///
    /// The screen (`resolve`) does not use this. It can ask the geocoder again when
    /// the preferred language has none, but for a reader with no way to ask again,
    /// such as MCP, a name in another language is more useful than coordinates alone.
    #[must_use]
    pub fn lookup(&self, locale: &str, key: &str) -> Option<&str> {
        let suffix = format!(":{key}");
        self.get(&cache_key(locale, key))
            .or_else(|| {
                self.places
                    .iter()
                    .find(|(k, _)| k.ends_with(&suffix))
                    .map(|(_, v)| v.as_str())
            })
            .or_else(|| self.get(key))
    }
}

/// The key inside the cache. Changing the language gives the same coordinates a
/// different name, so looking up by coordinates alone would show the name in the
/// previous language as is.
///
/// A cache written before this change (keys without a language) no longer matches.
/// It is a derived file, so it is not deleted; it is left to be rewritten with a
/// language the next time the same place is passed.
#[must_use]
pub fn cache_key(locale: &str, place_key: &str) -> String {
    format!("{locale}:{place_key}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn coordinates_within_the_same_grid_share_a_key() {
        assert_eq!(
            place_key(35.676_140_3, 139.546_563_4),
            place_key(35.676_9, 139.546_9)
        );
    }

    #[test]
    fn coordinates_a_town_apart_do_not() {
        assert_ne!(place_key(35.676, 139.546), place_key(35.651, 139.544));
    }

    /// If southern or western coordinates collapsed into a northeastern key, they would
    /// get a place name from the other side of the globe.
    #[test]
    fn the_key_keeps_the_hemisphere() {
        assert_eq!(place_key(-33.86, -70.66), "-33.86,-70.66");
    }

    #[test]
    fn an_answer_comes_back_under_its_key() {
        let mut cache = PlaceCache::default();

        cache.insert(place_key(35.676, 139.546), "渋谷区".to_string());

        assert_eq!(cache.get(&place_key(35.676, 139.546)), Some("渋谷区"));
    }

    #[test]
    fn a_coordinate_never_asked_about_is_absent() {
        assert_eq!(PlaceCache::default().get("0.00,0.00"), None);
    }

    #[test]
    fn what_was_saved_survives_a_reload() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("places.json");
        let mut cache = PlaceCache::default();
        cache.insert("35.68,139.55".to_string(), "渋谷区".to_string());

        cache.save(&path).unwrap();

        assert_eq!(PlaceCache::load(&path).get("35.68,139.55"), Some("渋谷区"));
    }

    /// It is a derivative, so a broken one is simply asked again. Scrawl failing to
    /// open because it cannot be read would be the worse problem.
    #[test]
    fn an_unreadable_cache_starts_empty() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("places.json");
        std::fs::write(&path, "{ not json").unwrap();

        assert!(PlaceCache::load(&path).is_empty());
    }

    #[test]
    fn a_missing_cache_starts_empty() {
        let tmp = TempDir::new().unwrap();

        assert!(PlaceCache::load(&tmp.path().join("places.json")).is_empty());
    }
    /// The name asked in the screen's language, if there is one. Otherwise one in
    /// another language still reads better than being shown coordinates alone.
    #[test]
    fn lookup_prefers_the_asked_language_and_falls_back_to_any() {
        let mut cache = PlaceCache::default();
        cache.insert(cache_key("ja", "35.68,139.55"), "渋谷区".to_string());
        cache.insert(cache_key("en", "35.68,139.55"), "Shibuya".to_string());
        cache.insert(cache_key("ja", "43.06,141.35"), "札幌市".to_string());

        assert_eq!(cache.lookup("en", "35.68,139.55"), Some("Shibuya"));
        assert_eq!(cache.lookup("en", "43.06,141.35"), Some("札幌市"));
        assert_eq!(cache.lookup("en", "0.00,0.00"), None);
    }

    /// A cache written before languages were added. It is not deleted, so it is read
    /// while it can be.
    #[test]
    fn lookup_reads_a_legacy_key_without_a_language() {
        let mut cache = PlaceCache::default();
        cache.insert("35.68,139.55".to_string(), "渋谷区".to_string());

        assert_eq!(cache.lookup("ja", "35.68,139.55"), Some("渋谷区"));
    }

    #[test]
    fn the_cache_remembers_which_language_it_asked_in() {
        assert_eq!(cache_key("en", "35.68,139.55"), "en:35.68,139.55");
        assert_ne!(
            cache_key("en", "35.68,139.55"),
            cache_key("ja", "35.68,139.55")
        );
    }
}
