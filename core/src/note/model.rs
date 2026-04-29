use std::path::PathBuf;

use chrono::{DateTime, FixedOffset};
use serde::Serialize;

use crate::shared::frontmatter::{self, NoteFrontmatter};

#[derive(Debug, Clone, Serialize)]
pub struct NoteSummary {
    pub path: PathBuf,
    pub filename: String,
    pub time: Option<DateTime<FixedOffset>>,
    pub tags: Vec<String>,
    pub preview: String,
}

impl NoteSummary {
    pub fn from_file(path: PathBuf, filename: String, content: &str) -> Self {
        let (time, tags, preview) = match frontmatter::parse::<NoteFrontmatter>(content) {
            Ok((fm, body)) => {
                let preview: String = body.chars().take(100).collect();
                (Some(fm.time), fm.tags, preview)
            }
            Err(_) => {
                let preview: String = content.chars().take(100).collect();
                (None, Vec::new(), preview)
            }
        };

        Self {
            path,
            filename,
            time,
            tags,
            preview,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::frontmatter::{ContextMeta, NoteFrontmatter};
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
            context: Some(ContextMeta {
                battery: 50,
                is_charging: false,
            }),
        };
        let content = frontmatter::render(&fm, "# Title\nBody").unwrap();
        let summary = NoteSummary::from_file(
            PathBuf::from("/test/note.md"),
            "note.md".to_string(),
            &content,
        );
        assert!(summary.time.is_some());
        assert_eq!(summary.tags, vec!["a", "b"]);
        assert!(summary.preview.contains("# Title"));
    }

    #[test]
    fn test_from_file_with_invalid_content() {
        let summary = NoteSummary::from_file(
            PathBuf::from("/test/note.md"),
            "note.md".to_string(),
            "no frontmatter here",
        );
        assert!(summary.time.is_none());
        assert!(summary.tags.is_empty());
        assert_eq!(summary.preview, "no frontmatter here");
    }
}
