use std::path::Path;

use chrono::{DateTime, Utc};

/// The mark that identifies a conflict copy. Only this file builds the name and reads it
/// back, so the spelling cannot drift apart in two places.
const CONFLICT_MARKER: &str = ".sync-conflict-";

#[must_use]
pub fn conflict_filename(key: &str, timestamp: DateTime<Utc>) -> String {
    let path = Path::new(key);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("md");
    let parent = path.parent().and_then(|p| p.to_str()).unwrap_or("");
    let ts = timestamp.format("%Y%m%d-%H%M%S");

    if parent.is_empty() {
        format!("{stem}{CONFLICT_MARKER}{ts}.{ext}")
    } else {
        format!("{parent}/{stem}{CONFLICT_MARKER}{ts}.{ext}")
    }
}

/// The inverse of `conflict_filename`. From a copy's key, returns the original key and the
/// time the copy was taken. `None` unless the name is a conflict copy's.
///
/// The extension is read by `Path`. Copies from before server-driven sync can carry a
/// name with one dot too many, such as `<stem>.sync-conflict-20260511-031336..md`, and a naive
/// cut at the first `.` leaves a dot in the timestamp.
fn conflict_copy_origin(key: &str) -> Option<(String, String)> {
    let (stem_path, rest) = key.split_once(CONFLICT_MARKER)?;
    let rest = Path::new(rest);
    let ext = rest.extension().and_then(|e| e.to_str()).unwrap_or("md");
    let timestamp = rest
        .file_stem()
        .and_then(|s| s.to_str())?
        .trim_end_matches('.');
    Some((format!("{stem_path}.{ext}"), timestamp.to_string()))
}

/// Where the copy is filed, relative to the copy store. `None` unless the name is a
/// conflict copy's.
///
/// The original key minus its extension becomes the directory, and the copy sits under it
/// by time (`notes/20260320_033440/20260511-031336.md`). This is the same shape as
/// `history/<stem>/<datetime>.md`, so however many copies one note gains, they gather in
/// one place.
#[must_use]
pub fn conflict_copy_path(key: &str) -> Option<String> {
    let (original, timestamp) = conflict_copy_origin(key)?;
    let path = Path::new(&original);
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("md");
    let dir = original.strip_suffix(&format!(".{ext}"))?;
    Some(format!("{dir}/{timestamp}.{ext}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn conflict_filename_with_parent() {
        let ts = Utc.with_ymd_and_hms(2026, 4, 22, 12, 0, 0).unwrap();
        assert_eq!(
            conflict_filename("notes/test.md", ts),
            "notes/test.sync-conflict-20260422-120000.md"
        );
    }

    #[test]
    fn conflict_filename_without_parent() {
        let ts = Utc.with_ymd_and_hms(2026, 4, 22, 12, 0, 0).unwrap();
        assert_eq!(
            conflict_filename("test.md", ts),
            "test.sync-conflict-20260422-120000.md"
        );
    }

    #[test]
    fn conflict_filename_nested_path() {
        let ts = Utc.with_ymd_and_hms(2026, 4, 22, 12, 0, 0).unwrap();
        assert_eq!(
            conflict_filename("notes/archive/2026/note.md", ts),
            "notes/archive/2026/note.sync-conflict-20260422-120000.md"
        );
    }

    /// To decide where a copy is filed, the original key must read back from the name.
    /// A key with a parent comes back with the parent.
    #[test]
    fn a_generated_name_reads_back_to_the_key_it_came_from() {
        let ts = Utc.with_ymd_and_hms(2026, 5, 11, 3, 13, 36).unwrap();
        for key in [
            "notes/20260320_033440.md",
            "note.md",
            "notes/archive/2026/note.md",
            "glyphs/236p.png",
        ] {
            assert_eq!(
                conflict_copy_origin(&conflict_filename(key, ts)),
                Some((key.to_string(), "20260511-031336".to_string())),
                "{key}"
            );
        }
    }

    #[test]
    fn a_name_without_the_marker_is_not_a_conflict_copy() {
        assert_eq!(conflict_copy_origin("notes/20260320_033440.md"), None);
        assert_eq!(conflict_copy_path("notes/20260320_033440.md"), None);
    }

    /// One directory of copies per original note. The same shape as history.
    #[test]
    fn a_copy_is_filed_under_the_note_it_came_from() {
        assert_eq!(
            conflict_copy_path("notes/20260320_033440.sync-conflict-20260511-031336.md"),
            Some("notes/20260320_033440/20260511-031336.md".to_string())
        );
        assert_eq!(
            conflict_copy_path("notes/archive/2026/note.sync-conflict-20260422-120000.md"),
            Some("notes/archive/2026/note/20260422-120000.md".to_string())
        );
    }

    /// Old copies still on disk have one dot too many. If that dot stays in the timestamp
    /// and goes into the directory name, copies of the same note split into two places.
    #[test]
    fn an_old_double_dotted_name_still_reads_back() {
        assert_eq!(
            conflict_copy_path("notes/20260320_033440.sync-conflict-20260511-031336..md"),
            Some("notes/20260320_033440/20260511-031336.md".to_string())
        );
    }
}
