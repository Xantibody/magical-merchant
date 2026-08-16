use std::path::PathBuf;

use chrono::{DateTime, FixedOffset};
use serde::Serialize;

use crate::utils::frontmatter::{self, NoteFrontmatter};
use crate::utils::tags;

#[derive(Debug, Clone, Serialize)]
pub struct Summary {
    pub path: PathBuf,
    pub filename: String,
    pub time: Option<DateTime<FixedOffset>>,
    pub tags: Vec<String>,
    pub preview: String,
    /// 昇格元エントリの日時。タイムラインが日毎のチップ表示を導出するのに使う。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

impl Summary {
    #[must_use]
    pub fn from_file(path: PathBuf, filename: String, content: &str) -> Self {
        let (time, mut tags, body, origin) =
            if let Ok((fm, body)) = frontmatter::parse::<NoteFrontmatter>(content) {
                (Some(fm.time), fm.tags, body, fm.origin)
            } else {
                // parse に失敗しても frontmatter の区切りは剥がす。壊れた
                // メタデータを本文扱いすると、一覧のタイトルとプレビューに YAML が出る。
                (None, Vec::new(), frontmatter::strip(content), None)
            };

        // 本文に書かれた `#タグ` が今の入力方法。frontmatter に残っているのは
        // タグ欄で付けていた頃のもので、消すと過去のノートから分類が消える。
        for tag in tags::parse(body) {
            if !tags.contains(&tag) {
                tags.push(tag);
            }
        }

        let preview: String = body.chars().take(100).collect();

        Self {
            path,
            filename,
            time,
            tags,
            preview,
            origin,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::device::Context;
    use crate::utils::frontmatter::NoteFrontmatter;
    use chrono::{FixedOffset, TimeZone};
    use std::path::PathBuf;

    #[test]
    fn test_from_file_with_valid_frontmatter() {
        let fm = NoteFrontmatter {
            time: FixedOffset::east_opt(9 * 3600)
                .unwrap()
                .with_ymd_and_hms(2026, 3, 20, 14, 30, 45)
                .unwrap(),
            tags: vec!["a".to_string(), "b".to_string()],
            context: Some(Context {
                battery: Some(50),
                is_charging: Some(false),
                ..Context::default()
            }),
            view: None,
            origin: None,
        };
        let content = frontmatter::render(&fm, "# Title\nBody").unwrap();
        let summary = Summary::from_file(
            PathBuf::from("/test/note.md"),
            "note.md".to_string(),
            &content,
        );
        assert!(summary.time.is_some());
        assert_eq!(summary.tags, vec!["a", "b"]);
        assert!(summary.preview.contains("# Title"));
    }

    /// origin はタイムラインのチップ表示が使う。一覧に乗らないと、昇格した
    /// ノートがどの日のものか誰にも分からない。
    #[test]
    fn test_from_file_carries_origin() {
        let fm = NoteFrontmatter {
            time: FixedOffset::east_opt(9 * 3600)
                .unwrap()
                .with_ymd_and_hms(2026, 8, 13, 9, 0, 0)
                .unwrap(),
            tags: vec![],
            context: None,
            view: None,
            origin: Some("2026-08-13T08:30:00".to_string()),
        };
        let content = frontmatter::render(&fm, "body").unwrap();
        let summary = Summary::from_file(
            PathBuf::from("/test/note.md"),
            "note.md".to_string(),
            &content,
        );
        assert_eq!(summary.origin, Some("2026-08-13T08:30:00".to_string()));
    }

    /// frontmatter が YAML として壊れているノート。時刻とタグは諦めるが、
    /// メタデータをタイトル・プレビューに出してはいけない。
    #[test]
    fn broken_frontmatter_does_not_leak_into_preview() {
        let content = "---\ntime: [broken\n---\n# Title\nbody";
        let summary = Summary::from_file(
            PathBuf::from("/test/note.md"),
            "note.md".to_string(),
            content,
        );
        assert!(summary.time.is_none());
        assert_eq!(summary.preview, "# Title\nbody");
    }

    #[test]
    fn test_from_file_with_invalid_content() {
        let summary = Summary::from_file(
            PathBuf::from("/test/note.md"),
            "note.md".to_string(),
            "no frontmatter here",
        );
        assert!(summary.time.is_none());
        assert!(summary.tags.is_empty());
        assert_eq!(summary.preview, "no frontmatter here");
    }
}
