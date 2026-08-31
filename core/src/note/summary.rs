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
        let (time, mut tags, body, origin, template) =
            if let Ok((fm, body)) = frontmatter::parse::<NoteFrontmatter>(content) {
                (Some(fm.time), fm.tags, body, fm.origin, fm.template)
            } else {
                // parse に失敗しても frontmatter の区切りは剥がす。壊れた
                // メタデータを本文扱いすると、一覧のタイトルとプレビューに YAML が出る。
                (None, Vec::new(), frontmatter::strip(content), None, None)
            };

        // 本文に書かれた `#タグ` が今の入力方法。frontmatter に残っているのは
        // タグ欄で付けていた頃のもので、消すと過去のノートから分類が消える。
        // 見せる形は本文側の規則に合わせる — ファイルの中身には手を付けない。
        for tag in &mut tags {
            tag.make_ascii_lowercase();
        }
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
        assert!(summary.time.is_some());
        assert_eq!(summary.tags, vec!["a", "b"]);
        assert!(summary.preview.contains("# Title"));
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
