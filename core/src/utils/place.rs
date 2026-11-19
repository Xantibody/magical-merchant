//! How the place names, once received, are kept on disk.

use std::path::Path;

use crate::domain::device::PlaceCache;
use crate::error::CoreError;
use crate::services::files::write_atomic;

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
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

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
}
