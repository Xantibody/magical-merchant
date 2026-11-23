use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::domain::data::data_dir;
use crate::utils::clock::Stamp;

pub(crate) const NOTES_DIR: &str = "notes";
const CODEX_DIR: &str = "codex";

#[must_use]
pub(crate) fn notes_dir(base_dir: &Path) -> PathBuf {
    data_dir(base_dir).join(NOTES_DIR)
}

/// Where a Codex (a document that keeps growing) and its versions live.
///
/// Inside `data/` because it should sync: a history that differs per device does
/// not accumulate. Separate from `notes/` so that it sits where a `list_notes`
/// from a version that does not know Codex never reads. Separating by a
/// frontmatter key instead, the key would drop the moment an unknowing version
/// saved, and it would turn back into a plain note.
#[must_use]
pub(crate) fn codex_dir(base_dir: &Path) -> PathBuf {
    data_dir(base_dir).join(CODEX_DIR)
}

/// The kind of a note. The directory it lives in decides it, not the frontmatter.
///
/// A `Note` is a single document; a `Codex` is a document that keeps growing and commits
/// versions. Telling them apart by a frontmatter key would drop the key the moment a build
/// that does not know Codex saves, turning it back into a plain note. With a directory, an
/// unaware build just does not read it, and breaks nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteKind {
    Note,
    Codex,
}

impl NoteKind {
    /// The directory where notes of this kind sit.
    #[must_use]
    pub fn dir(self, base_dir: &Path) -> PathBuf {
        match self {
            Self::Note => notes_dir(base_dir),
            Self::Codex => codex_dir(base_dir),
        }
    }

    /// The file location decided by the creation time. The naming is the same for every
    /// kind: IDs share one namespace across kinds, and promotion is only a rename.
    #[must_use]
    pub fn file_path(self, base_dir: &Path, time: Stamp) -> PathBuf {
        self.dir(base_dir).join(format!("{}.md", time.id_stem()))
    }

    /// The same spelling as the JSON output. For exits (MCP) that do not know core's serde.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Note => "note",
            Self::Codex => "codex",
        }
    }

    /// The counterpart, for checking that the same ID is not in the other location.
    #[must_use]
    pub const fn other(self) -> Self {
        match self {
            Self::Note => Self::Codex,
            Self::Codex => Self::Note,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_kind_has_its_own_directory_but_the_same_naming() {
        let time = Stamp::new(2026, 3, 20, 14, 30, 45, 9 * 3600).unwrap();
        assert_eq!(
            NoteKind::Note.file_path(Path::new("/app"), time),
            PathBuf::from("/app/data/notes/20260320_143045.md")
        );
        assert_eq!(
            NoteKind::Codex.file_path(Path::new("/app"), time),
            PathBuf::from("/app/data/codex/20260320_143045.md")
        );
    }

    /// For the same instant, the name follows the wall clock of the offset the
    /// timestamp names. An import passes the original record's `+09:00` as is, so
    /// the date does not move with the timezone of the device that ran it.
    #[test]
    fn the_filename_follows_the_timestamps_own_offset() {
        let jst = Stamp::new(2026, 3, 20, 0, 30, 0, 9 * 3600).unwrap();

        assert_eq!(
            NoteKind::Note.file_path(Path::new("/app"), jst),
            PathBuf::from("/app/data/notes/20260320_003000.md")
        );
        let utc = Stamp::new(2026, 3, 19, 15, 30, 0, 0).unwrap();
        assert_eq!(utc, jst, "the same instant");
        assert_eq!(
            NoteKind::Note.file_path(Path::new("/app"), utc),
            PathBuf::from("/app/data/notes/20260319_153000.md")
        );
    }

    #[test]
    fn test_notes_dir() {
        let path = notes_dir(Path::new("/app"));
        assert_eq!(path, PathBuf::from("/app/data/notes"));
    }

    /// Codex versions are inside `data/`. A person committed them, so they reach the other devices.
    #[test]
    fn codex_versions_live_inside_the_synced_tree() {
        assert_eq!(
            codex_dir(Path::new("/app")),
            PathBuf::from("/app/data/codex")
        );
    }

    /// List and search pass the kind as JSON. It matches `"note" | "codex"` on the TS side.
    #[test]
    fn serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&NoteKind::Codex).unwrap(),
            "\"codex\""
        );
        assert_eq!(
            serde_json::from_str::<NoteKind>("\"note\"").unwrap(),
            NoteKind::Note
        );
    }
}
