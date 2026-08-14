use chrono::{DateTime, Local, NaiveDate};
use std::path::{Path, PathBuf};

pub const DATA_DIR: &str = "data";
pub const TIMELINE_DIR: &str = "timeline";
pub const NOTES_DIR: &str = "notes";

#[must_use]
pub fn data_dir(base_dir: &Path) -> PathBuf {
    base_dir.join(DATA_DIR)
}

#[must_use]
pub fn timeline_file_path(base_dir: &Path, date: NaiveDate) -> PathBuf {
    data_dir(base_dir)
        .join(TIMELINE_DIR)
        .join(format!("{}.md", date.format("%Y-%m-%d")))
}

#[must_use]
pub fn note_file_path(base_dir: &Path, timestamp: DateTime<Local>) -> PathBuf {
    data_dir(base_dir)
        .join(NOTES_DIR)
        .join(format!("{}.md", timestamp.format("%Y%m%d_%H%M%S")))
}

#[must_use]
pub fn notes_dir(base_dir: &Path) -> PathBuf {
    data_dir(base_dir).join(NOTES_DIR)
}

/// 地名キャッシュの置き場。
///
/// `data/` の外に置く。中身は座標から引き直せる派生物でしかなく、同期に
/// 載せると端末ごとに違う言語のキャッシュが往復するだけになる。
#[must_use]
pub fn place_cache_path(base_dir: &Path) -> PathBuf {
    base_dir.join("places.json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn test_timeline_file_path() {
        let date = NaiveDate::from_ymd_opt(2026, 3, 20).unwrap();
        let path = timeline_file_path(Path::new("/app"), date);
        assert_eq!(path, PathBuf::from("/app/data/timeline/2026-03-20.md"));
    }

    #[test]
    fn test_note_file_path() {
        let ts = Local.with_ymd_and_hms(2026, 3, 20, 14, 30, 45).unwrap();
        let path = note_file_path(Path::new("/app"), ts);
        assert_eq!(path, PathBuf::from("/app/data/notes/20260320_143045.md"));
    }

    #[test]
    fn test_notes_dir() {
        let path = notes_dir(Path::new("/app"));
        assert_eq!(path, PathBuf::from("/app/data/notes"));
    }

    /// 同期されるのは `data/` 以下だけ。派生物のキャッシュはその外に置く。
    #[test]
    fn the_place_cache_sits_outside_the_synced_tree() {
        assert_eq!(
            place_cache_path(Path::new("/app")),
            PathBuf::from("/app/places.json")
        );
    }
}
