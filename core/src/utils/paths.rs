use std::path::{Path, PathBuf};

/// Where the place-name cache lives.
///
/// Outside `data/`. The content is only a derivative that can be looked up again
/// from coordinates; on sync, caches in a different language per device would just
/// travel back and forth.
#[must_use]
pub fn place_cache_path(base_dir: &Path) -> PathBuf {
    base_dir.join("places.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Only what is under `data/` syncs. A derivative cache sits outside it.
    #[test]
    fn the_place_cache_sits_outside_the_synced_tree() {
        assert_eq!(
            place_cache_path(Path::new("/app")),
            PathBuf::from("/app/places.json")
        );
    }
}
