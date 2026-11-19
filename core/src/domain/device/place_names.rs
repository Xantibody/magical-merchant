//! The place names asked once, kept in `places.json` beside `data/`.

use std::path::{Path, PathBuf};

use super::place::PlaceCache;
use crate::error::CoreError;
use crate::services::files;

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
}
