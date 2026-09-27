//! The note an editor beside the app is on, so an app started to follow it can show the same.
//!
//! It is one line in `<base>/follow`: outside `data/`, because it is this machine's state
//! and must never sync. The CLI writes it (`magical-merchant follow`); the desktop app reads
//! it only when it was started with `--follow`, so a file left from yesterday cannot move a
//! window nobody asked to follow.

use std::path::{Path, PathBuf};

use crate::utils::fs::write_atomic;
use crate::{CoreError, NoteFilename};

const FOLLOW_FILE: &str = "follow";

#[must_use]
pub fn follow_file(base_dir: &Path) -> PathBuf {
    base_dir.join(FOLLOW_FILE)
}

/// Says which note to show. Written whole, so the app never reads half a name.
pub fn follow(base_dir: &Path, filename: &NoteFilename) -> Result<(), CoreError> {
    write_atomic(&follow_file(base_dir), format!("{}\n", filename.as_str()))
}

/// The note to show, if the file names one.
#[must_use]
pub fn followed(base_dir: &Path) -> Option<NoteFilename> {
    let text = std::fs::read_to_string(follow_file(base_dir)).ok()?;
    NoteFilename::parse(text.trim()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn stem(name: &str) -> NoteFilename {
        NoteFilename::parse(name).unwrap()
    }

    #[test]
    fn nothing_is_followed_before_anything_was_written() {
        let tmp = TempDir::new().unwrap();

        assert_eq!(followed(tmp.path()), None);
    }

    #[test]
    fn the_note_last_written_is_the_one_followed() {
        let tmp = TempDir::new().unwrap();

        follow(tmp.path(), &stem("20260320_143045.md")).unwrap();
        follow(tmp.path(), &stem("20260321_090000.md")).unwrap();

        assert_eq!(followed(tmp.path()), Some(stem("20260321_090000.md")));
    }

    // The file is outside the app's hands; a line that is not a note ID is ignored, not trusted
    #[test]
    fn a_line_that_is_not_a_note_id_is_nothing_to_follow() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(follow_file(tmp.path()), "../../etc/passwd\n").unwrap();

        assert_eq!(followed(tmp.path()), None);
    }
}
