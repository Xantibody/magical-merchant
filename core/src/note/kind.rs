use std::path::{Path, PathBuf};

use chrono::{DateTime, FixedOffset};
use serde::{Deserialize, Serialize};

use crate::utils::paths::{codex_dir, notes_dir};

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
    pub fn file_path(self, base_dir: &Path, time: DateTime<FixedOffset>) -> PathBuf {
        self.dir(base_dir)
            .join(format!("{}.md", time.format("%Y%m%d_%H%M%S")))
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
    use chrono::TimeZone;

    #[test]
    fn each_kind_has_its_own_directory_but_the_same_naming() {
        let time = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 20, 14, 30, 45)
            .unwrap();
        assert_eq!(
            NoteKind::Note.file_path(Path::new("/app"), time),
            PathBuf::from("/app/data/notes/20260320_143045.md")
        );
        assert_eq!(
            NoteKind::Codex.file_path(Path::new("/app"), time),
            PathBuf::from("/app/data/codex/20260320_143045.md")
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
