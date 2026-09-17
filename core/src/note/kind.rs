use std::path::{Path, PathBuf};

use chrono::{DateTime, FixedOffset};
use serde::{Deserialize, Serialize};

use crate::utils::paths::{codex_dir, notes_dir};

/// ノートの種別。決めるのは置き場のディレクトリで、frontmatter ではない。
///
/// `Note` は 1 本の文書、`Codex` は書き足し続けて版を刻む文書。frontmatter の
/// キーで分けると、Codex を知らない版が保存した瞬間にキーが落ちて普通の
/// ノートに戻る。ディレクトリなら知らない版は読まないだけで、壊さない。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteKind {
    Note,
    Codex,
}

impl NoteKind {
    /// この種別のノートが並ぶディレクトリ。
    #[must_use]
    pub fn dir(self, base_dir: &Path) -> PathBuf {
        match self {
            Self::Note => notes_dir(base_dir),
            Self::Codex => codex_dir(base_dir),
        }
    }

    /// 作成時刻から決まるファイルの置き場。名前の付け方は種別によらず
    /// 同じ — ID は種別をまたいでも 1 つの名前空間で、昇格は rename だけ。
    #[must_use]
    pub fn file_path(self, base_dir: &Path, time: DateTime<FixedOffset>) -> PathBuf {
        self.dir(base_dir)
            .join(format!("{}.md", time.format("%Y%m%d_%H%M%S")))
    }

    /// JSON に出すのと同じ綴り。core の serde を知らない出口(MCP)向け。
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Note => "note",
            Self::Codex => "codex",
        }
    }

    /// 同じ ID がもう片方の置き場に無いか確かめるための相方。
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

    /// 一覧と検索は JSON で種別を渡す。TS 側の `"note" | "codex"` と揃える。
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
