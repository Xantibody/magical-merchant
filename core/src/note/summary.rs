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
    /// 生まれ元のテンプレ名。テンプレ起動が「同じテンプレの今日のノート」と
    /// 直近の 1 本をここから探すので、一覧に乗っていないと毎回全ファイルを
    /// 開き直すことになる。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
}

impl Summary {
    #[must_use]
    pub fn from_file(path: PathBuf, filename: String, content: &str) -> Self {
        let (time, tags, body, origin, template) =
            if let Ok((fm, body)) = frontmatter::parse::<NoteFrontmatter>(content) {
                (Some(fm.time), fm.tags, body, fm.origin, fm.template)
            } else {
                // parse に失敗しても frontmatter の区切りは剥がす。壊れた
                // メタデータを本文扱いすると、一覧のタイトルとプレビューに YAML が出る。
                (None, Vec::new(), frontmatter::strip(content), None, None)
            };

        let tags = tags::merge(tags, body);
        let preview: String = body.chars().take(100).collect();

        Self {
            path,
            filename,
            time,
            tags,
            preview,
            origin,
            template,
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

    fn at(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> NoteFrontmatter {
        NoteFrontmatter::new(
            FixedOffset::east_opt(9 * 3600)
                .unwrap()
                .with_ymd_and_hms(year, month, day, hour, minute, 0)
                .unwrap(),
        )
    }

    #[test]
    fn test_from_file_with_valid_frontmatter() {
        let fm = NoteFrontmatter {
            tags: vec!["a".to_string(), "b".to_string()],
            context: Some(Context {
                battery: Some(50),
                is_charging: Some(false),
                ..Context::default()
            }),
            ..at(2026, 3, 20, 14, 30)
        };
        let content = frontmatter::render(&fm, "# Title\nBody").unwrap();
        let summary = Summary::from_file(
            PathBuf::from("/test/note.md"),
            "note.md".to_string(),
            &content,
        );
        assert_eq!(
            summary.time,
            Some(
                FixedOffset::east_opt(9 * 3600)
                    .unwrap()
                    .with_ymd_and_hms(2026, 3, 20, 14, 30, 0)
                    .unwrap()
            )
        );
        assert_eq!(summary.tags, vec!["a", "b"]);
        assert_eq!(summary.preview, "# Title\nBody");
    }

    /// 一覧に載せるのは先頭 100 文字。バイトではなく文字で切らないと、
    /// 日本語の本文は 3 分の 1 しか見えない。
    #[test]
    fn the_preview_is_the_first_hundred_chars_of_the_body() {
        let preview_of = |len: usize| {
            let body = "あ".repeat(len);
            let content = frontmatter::render(&at(2026, 3, 20, 14, 30), &body).unwrap();
            Summary::from_file(
                PathBuf::from("/test/note.md"),
                "note.md".to_string(),
                &content,
            )
            .preview
        };

        assert_eq!(preview_of(99).chars().count(), 99);
        assert_eq!(preview_of(100).chars().count(), 100);
        assert_eq!(preview_of(101).chars().count(), 100);
        assert_eq!(preview_of(101), "あ".repeat(100));
    }

    /// origin はタイムラインのチップ表示が使う。一覧に乗らないと、昇格した
    /// ノートがどの日のものか誰にも分からない。
    #[test]
    fn test_from_file_carries_origin() {
        let fm = NoteFrontmatter {
            origin: Some("2026-08-13T08:30:00".to_string()),
            ..at(2026, 8, 13, 9, 0)
        };
        let content = frontmatter::render(&fm, "body").unwrap();
        let summary = Summary::from_file(
            PathBuf::from("/test/note.md"),
            "note.md".to_string(),
            &content,
        );
        assert_eq!(summary.origin, Some("2026-08-13T08:30:00".to_string()));
    }

    /// タグ欄で `Rust` と付けていた頃のノートに本文で `#rust` と書いたら、
    /// 一覧に同じ分類が 2 つ並ぶ。同一性は本文側の規則(ASCII 小文字)で決める。
    #[test]
    fn frontmatter_tags_are_normalized_like_body_tags() {
        let fm = NoteFrontmatter {
            tags: vec!["Rust".to_string()],
            ..at(2026, 3, 20, 14, 30)
        };
        let content = frontmatter::render(&fm, "本文 #rust").unwrap();
        let summary = Summary::from_file(
            PathBuf::from("/test/note.md"),
            "note.md".to_string(),
            &content,
        );
        assert_eq!(summary.tags, vec!["rust"]);
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
