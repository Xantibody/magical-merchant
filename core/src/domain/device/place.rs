//! Where the answers from turning coordinates into place names are kept.
//!
//! The conversion itself is left to the OS geocoder, so all that is here is "how
//! close counts as the same place" and "how an answer, once received, is kept".
//!
//! The recorded coordinates are never touched. A place name is only a coarse
//! paraphrase for reading; written back into the trailing JSON, the record of
//! where you were would be at the mercy of the geocoder.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

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

/// The centre of a place's cell on one axis, as the list of places reports it: the
/// coordinate rounded to the key's two digits, as a number.
///
/// It names the same cell as [`place_key`] everywhere but on the half-cent boundary
/// itself, where the two part: the key formats the binary value (35.665 is a hair under,
/// so `35.66`; 0.125 is exact and goes to even, `0.12`), while this multiplies by 100
/// first and rounds half away from zero (`35.67`, `0.13`). A recorded coordinate rarely
/// ends on the boundary.
// AIDEV-NOTE: the half-cent mismatch with place_key stays: list_places's output is a join key for an MCP that wraps this one, so aligning the two would break that join
pub(crate) fn cell_centre(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
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
    /// The screen (`place_names::resolve`) does not use this. It can ask the geocoder again when
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

    /// A place's centre names the same cell as its key, everywhere off the half-cent
    /// boundary: a grid over both hemispheres, and the values just either side of the
    /// boundary.
    #[test]
    fn a_cell_centre_falls_in_the_cell_its_key_names() {
        let mut values: Vec<f64> = (-180_000..=180_000)
            .map(|i| f64::from(i) / 1000.0 + 0.0003)
            .collect();
        for cent in -18_000..=18_000 {
            let boundary = f64::from(cent) / 100.0 + 0.005;
            values.push(boundary - 1e-7);
            values.push(boundary + 1e-7);
        }

        for value in values {
            assert_eq!(
                place_key(cell_centre(value), cell_centre(value)),
                place_key(value, value),
                "{value}"
            );
        }
    }

    /// On the half-cent boundary itself the two roundings part, as `cell_centre` says.
    #[test]
    fn on_the_half_cent_boundary_the_centre_and_the_key_part() {
        for (value, key, centre) in [
            (35.665, "35.66", "35.67"),
            (0.125, "0.12", "0.13"),
            (-0.125, "-0.12", "-0.13"),
        ] {
            assert_eq!(place_key(value, 0.0), format!("{key},0.00"), "{value}");
            assert_eq!(cell_centre(value).to_string(), centre, "{value}");
        }
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
