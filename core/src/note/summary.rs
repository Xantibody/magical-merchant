use std::path::PathBuf;

use chrono::{DateTime, FixedOffset};
use serde::Serialize;

use crate::utils::frontmatter::{self, NoteFrontmatter};
use crate::utils::tags;

use super::kind::NoteKind;

#[derive(Debug, Clone, Serialize)]
pub struct Summary {
    /// Which location it came from. The list filters by kind per surface.
    pub kind: NoteKind,
    pub path: PathBuf,
    pub filename: String,
    pub time: Option<DateTime<FixedOffset>>,
    pub tags: Vec<String>,
    pub preview: String,
    /// The datetime of the entry it was promoted from. Scrawl derives the per-day chips from it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    /// The name of the template it was born from. Launching a template looks here for
    /// "today's note from the same template" and for the most recent one, so without it
    /// on the list every launch would reopen every file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    /// The view mode (`preview` / `mindmap`). The list uses it to show a lock on read-only
    /// notes. If it were unknown until the body opens, one would try to write an unwritable note.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view: Option<String>,
    /// The number of committed versions. Only Codex rows have it; the list shows it on the
    /// folded-corner page symbol.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_count: Option<usize>,
    /// Whether the draft has moved on from the latest version. Codex rows only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dirty: Option<bool>,
}

impl Summary {
    #[must_use]
    pub fn from_file(kind: NoteKind, path: PathBuf, filename: String, content: &str) -> Self {
        let (time, tags, body, origin, template, view) =
            if let Ok((fm, body)) = frontmatter::parse::<NoteFrontmatter>(content) {
                (
                    Some(fm.time),
                    fm.tags,
                    body,
                    fm.origin,
                    fm.template,
                    fm.view,
                )
            } else {
                // Strip the frontmatter delimiters even when the parse fails. Treating broken
                // metadata as body would put YAML into the list's title and preview.
                (
                    None,
                    Vec::new(),
                    frontmatter::strip(content),
                    None,
                    None,
                    None,
                )
            };

        let tags = tags::merge(tags, body);
        let preview: String = body.chars().take(100).collect();

        Self {
            kind,
            path,
            filename,
            time,
            tags,
            preview,
            origin,
            template,
            view,
            version_count: None,
            dirty: None,
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
            NoteKind::Note,
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

    /// The list shows the first 100 characters. Cutting by characters rather than bytes
    /// matters: a Japanese body would otherwise show only a third of that.
    #[test]
    fn the_preview_is_the_first_hundred_chars_of_the_body() {
        let preview_of = |len: usize| {
            let body = "あ".repeat(len);
            let content = frontmatter::render(&at(2026, 3, 20, 14, 30), &body).unwrap();
            Summary::from_file(
                NoteKind::Note,
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

    /// A note made read-only shows a lock on the list too. Without it on the list, one
    /// would not know the note is unwritable until opening it and trying to write.
    #[test]
    fn from_file_carries_the_view() {
        let fm = NoteFrontmatter {
            view: Some("preview".to_string()),
            ..at(2026, 9, 5, 21, 14)
        };
        let content = frontmatter::render(&fm, "body").unwrap();
        let summary = Summary::from_file(
            NoteKind::Note,
            PathBuf::from("/test/note.md"),
            "note.md".to_string(),
            &content,
        );
        assert_eq!(summary.view, Some("preview".to_string()));
    }

    /// Scrawl's chips use origin. Without it on the list, nobody can tell which day a
    /// promoted note belongs to.
    #[test]
    fn test_from_file_carries_origin() {
        let fm = NoteFrontmatter {
            origin: Some("2026-08-13T08:30:00".to_string()),
            ..at(2026, 8, 13, 9, 0)
        };
        let content = frontmatter::render(&fm, "body").unwrap();
        let summary = Summary::from_file(
            NoteKind::Note,
            PathBuf::from("/test/note.md"),
            "note.md".to_string(),
            &content,
        );
        assert_eq!(summary.origin, Some("2026-08-13T08:30:00".to_string()));
    }

    /// Writing `#rust` in the body of a note tagged `Rust` back when the tag field was used
    /// puts the same category on the list twice. Fold them into one ignoring case, and keep
    /// the frontmatter's spelling.
    #[test]
    fn frontmatter_tags_are_merged_with_body_tags_ignoring_case() {
        let fm = NoteFrontmatter {
            tags: vec!["Rust".to_string()],
            ..at(2026, 3, 20, 14, 30)
        };
        let content = frontmatter::render(&fm, "本文 #rust").unwrap();
        let summary = Summary::from_file(
            NoteKind::Note,
            PathBuf::from("/test/note.md"),
            "note.md".to_string(),
            &content,
        );
        assert_eq!(summary.tags, vec!["Rust"]);
    }

    /// A note whose frontmatter is broken as YAML. The time and tags are given up, but the
    /// metadata must not show up in the title or the preview.
    #[test]
    fn broken_frontmatter_does_not_leak_into_preview() {
        let content = "---\ntime: [broken\n---\n# Title\nbody";
        let summary = Summary::from_file(
            NoteKind::Note,
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
            NoteKind::Note,
            PathBuf::from("/test/note.md"),
            "note.md".to_string(),
            "no frontmatter here",
        );
        assert!(summary.time.is_none());
        assert!(summary.tags.is_empty());
        assert_eq!(summary.preview, "no frontmatter here");
    }
}
