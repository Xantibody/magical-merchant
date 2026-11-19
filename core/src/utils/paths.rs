use std::path::{Path, PathBuf};

/// Where the copy of a note taken before a rewrite lives.
///
/// Outside `data/`. Put on sync, a copy would travel between devices on every
/// rewrite. A copy is for restoring, not for sharing.
#[must_use]
pub fn history_dir(base_dir: &Path) -> PathBuf {
    base_dir.join("history")
}

/// Where the copy of the side that lost a conflict lives.
///
/// Outside `data/`. It stays out of the sync scan, and also out of the
/// `data/notes/*.md` the note list picks up. A copy is for restoring, not
/// something to line up as a note that keeps being written.
#[must_use]
pub fn conflicts_dir(base_dir: &Path) -> PathBuf {
    base_dir.join("conflicts")
}

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

    /// Copies sit outside `data/`, like history. Inside, they would travel back and
    /// forth on sync and also line up in the note list.
    #[test]
    fn conflict_copies_sit_outside_the_synced_tree() {
        assert_eq!(
            conflicts_dir(Path::new("/app")),
            PathBuf::from("/app/conflicts")
        );
    }

    /// Only what is under `data/` syncs. A derivative cache sits outside it.
    #[test]
    fn the_place_cache_sits_outside_the_synced_tree() {
        assert_eq!(
            place_cache_path(Path::new("/app")),
            PathBuf::from("/app/places.json")
        );
    }
}
