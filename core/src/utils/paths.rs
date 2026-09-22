use chrono::{DateTime, FixedOffset, NaiveDate};
use std::path::{Path, PathBuf};

pub const DATA_DIR: &str = "data";
pub const SCRAWL_DIR: &str = "scrawl";
pub const NOTES_DIR: &str = "notes";
pub const CODEX_DIR: &str = "codex";
pub const TEMPLATES_DIR: &str = "templates";
pub const GLYPHS_DIR: &str = "glyphs";

#[must_use]
pub fn data_dir(base_dir: &Path) -> PathBuf {
    base_dir.join(DATA_DIR)
}

#[must_use]
pub fn scrawl_file_path(base_dir: &Path, date: NaiveDate) -> PathBuf {
    data_dir(base_dir)
        .join(SCRAWL_DIR)
        .join(format!("{}.md", date.format("%Y-%m-%d")))
}

/// The filename follows the wall clock of the place the timestamp points at. It
/// takes a `FixedOffset` so the same type as the frontmatter `time` is carried
/// through as is: converting to the device's timezone here would shift only the
/// date in the ID when a `+09:00` record is rebuilt in another place.
#[must_use]
pub fn note_file_path(base_dir: &Path, timestamp: DateTime<FixedOffset>) -> PathBuf {
    data_dir(base_dir)
        .join(NOTES_DIR)
        .join(format!("{}.md", timestamp.format("%Y%m%d_%H%M%S")))
}

#[must_use]
pub fn notes_dir(base_dir: &Path) -> PathBuf {
    data_dir(base_dir).join(NOTES_DIR)
}

/// Where templates live. Inside `data/` because templates should sync too.
/// With different templates per device, tapping the same name from the widget
/// would produce a different note depending on the device.
#[must_use]
pub fn templates_dir(base_dir: &Path) -> PathBuf {
    data_dir(base_dir).join(TEMPLATES_DIR)
}

/// Where special-character (glyph) images live. Inside `data/` because the images
/// should sync too. If a note with `:236p:` showed as plain text on another device,
/// registering it would be pointless. The sync scan walks everything under data
/// without selecting by extension.
#[must_use]
pub fn glyphs_dir(base_dir: &Path) -> PathBuf {
    data_dir(base_dir).join(GLYPHS_DIR)
}

/// Where a Codex (a document that keeps growing) and its versions live.
///
/// Inside `data/` because it should sync: a history that differs per device does
/// not accumulate. Separate from `notes/` so that it sits where a `list_notes`
/// from a version that does not know Codex never reads. Separating by a
/// frontmatter key instead, the key would drop the moment an unknowing version
/// saved, and it would turn back into a plain note.
#[must_use]
pub fn codex_dir(base_dir: &Path) -> PathBuf {
    data_dir(base_dir).join(CODEX_DIR)
}

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
    use chrono::TimeZone;

    #[test]
    fn test_scrawl_file_path() {
        let date = NaiveDate::from_ymd_opt(2026, 3, 20).unwrap();
        let path = scrawl_file_path(Path::new("/app"), date);
        assert_eq!(path, PathBuf::from("/app/data/scrawl/2026-03-20.md"));
    }

    #[test]
    fn test_note_file_path() {
        let ts = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 20, 14, 30, 45)
            .unwrap();
        let path = note_file_path(Path::new("/app"), ts);
        assert_eq!(path, PathBuf::from("/app/data/notes/20260320_143045.md"));
    }

    /// For the same instant, the name follows the wall clock of the offset the
    /// timestamp names. An import passes the original record's `+09:00` as is, so
    /// the date does not move with the timezone of the device that ran it.
    #[test]
    fn the_filename_follows_the_timestamps_own_offset() {
        let jst = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 20, 0, 30, 0)
            .unwrap();

        assert_eq!(
            note_file_path(Path::new("/app"), jst),
            PathBuf::from("/app/data/notes/20260320_003000.md")
        );
        assert_eq!(
            note_file_path(
                Path::new("/app"),
                jst.with_timezone(&chrono::Utc).fixed_offset()
            ),
            PathBuf::from("/app/data/notes/20260319_153000.md")
        );
    }

    #[test]
    fn test_notes_dir() {
        let path = notes_dir(Path::new("/app"));
        assert_eq!(path, PathBuf::from("/app/data/notes"));
    }

    /// Templates are inside `data/` too. The sync scan walks everything under data,
    /// so just being here gets them to the other devices.
    #[test]
    fn templates_live_inside_the_synced_tree() {
        assert_eq!(
            templates_dir(Path::new("/app")),
            PathBuf::from("/app/data/templates")
        );
    }

    /// Glyph images are inside `data/` too. They reach the other devices along with the notes.
    #[test]
    fn glyphs_live_inside_the_synced_tree() {
        assert_eq!(
            glyphs_dir(Path::new("/app")),
            PathBuf::from("/app/data/glyphs")
        );
    }

    /// Codex versions are inside `data/`. A person committed them, so they reach the other devices.
    #[test]
    fn codex_versions_live_inside_the_synced_tree() {
        assert_eq!(
            codex_dir(Path::new("/app")),
            PathBuf::from("/app/data/codex")
        );
    }

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
