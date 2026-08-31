use std::path::Path;

use chrono::{DateTime, Utc};

#[must_use]
pub fn conflict_filename(key: &str, timestamp: DateTime<Utc>) -> String {
    let path = Path::new(key);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("md");
    let parent = path.parent().and_then(|p| p.to_str()).unwrap_or("");
    let ts = timestamp.format("%Y%m%d-%H%M%S");

    if parent.is_empty() {
        format!("{stem}.sync-conflict-{ts}.{ext}")
    } else {
        format!("{parent}/{stem}.sync-conflict-{ts}.{ext}")
    }
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
}
