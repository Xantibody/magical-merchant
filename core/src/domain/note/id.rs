//! A note's ID: its filename, `YYYYMMDD_HHMMSS.md`, given at creation and never renamed.

use std::cmp::Reverse;
use std::fmt;

use crate::error::CoreError;

/// A filename that names one file directly under a note directory and nothing else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteFilename(String);

impl NoteFilename {
    pub fn parse(s: &str) -> Result<Self, CoreError> {
        let path = std::path::Path::new(s);
        if s.is_empty()
            || s.contains("..")
            || s.contains('/')
            || s.contains('\\')
            || s.contains('\0')
            || path.components().count() != 1
            || path.extension().and_then(|ext| ext.to_str()) != Some("md")
        {
            return Err(CoreError::PathTraversal(s.to_string()));
        }
        Ok(Self(s.to_string()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for NoteFilename {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Orders `items` newest first: the descending order of the name `name_of` reads from each.
///
/// An ID is the creation time written so that name order is time order, and a Codex
/// version's name starts with the time it was committed, so the greatest name is the
/// newest. Every list in the app reads from the newest down.
pub(crate) fn newest_first<T, K, F>(items: &mut [T], name_of: F)
where
    K: Ord,
    F: FnMut(&T) -> K,
{
    let mut name_of = name_of;
    // The name is read once per item, not on every comparison: reading a directory
    // entry's name allocates.
    items.sort_by_cached_key(|item| Reverse(name_of(item)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newest_first_puts_the_greatest_name_on_top() {
        let mut names = vec![
            "20260101_120000.md",
            "20260320_143045.md",
            "20251231_235959.md",
            "20260320_143044.md",
        ];

        newest_first(&mut names, |name| *name);

        assert_eq!(
            names,
            vec![
                "20260320_143045.md",
                "20260320_143044.md",
                "20260101_120000.md",
                "20251231_235959.md",
            ]
        );
    }

    /// The order reads only the name: whatever else an item carries rides along.
    #[test]
    fn newest_first_orders_items_by_the_name_they_carry() {
        let mut rows = vec![
            ("codex", "20260101_000000.md"),
            ("note", "20260102_000000.md"),
        ];

        newest_first(&mut rows, |(_, name)| *name);

        assert_eq!(
            rows,
            vec![
                ("note", "20260102_000000.md"),
                ("codex", "20260101_000000.md")
            ]
        );
    }

    /// A Codex version's name starts with the second it was committed, then its hash:
    /// within one second the hash decides, so the order is the same on every device.
    #[test]
    fn newest_first_orders_version_names_by_their_time_then_hash() {
        let mut names = vec![
            "20260917_140300-0123abcd.md",
            "20260917_140301-00000000.md",
            "20260917_140300-ffff0000.md",
        ];

        newest_first(&mut names, |name| *name);

        assert_eq!(
            names,
            vec![
                "20260917_140301-00000000.md",
                "20260917_140300-ffff0000.md",
                "20260917_140300-0123abcd.md",
            ]
        );
    }

    #[test]
    fn newest_first_leaves_an_empty_list_empty() {
        let mut none: Vec<&str> = Vec::new();

        newest_first(&mut none, |name| *name);

        assert!(none.is_empty());
    }

    #[test]
    fn test_note_filename_parse_valid() {
        assert!(NoteFilename::parse("20260101_120000.md").is_ok());
        assert!(NoteFilename::parse("my-note.md").is_ok());
    }

    #[test]
    fn test_note_filename_parse_invalid() {
        assert!(NoteFilename::parse("").is_err());
        assert!(NoteFilename::parse("../etc/passwd").is_err());
        assert!(NoteFilename::parse("/tmp/evil.md").is_err());
        assert!(NoteFilename::parse("evil.txt").is_err());
        assert!(NoteFilename::parse("no-extension").is_err());
        assert!(NoteFilename::parse("foo\0bar.md").is_err());
    }

    #[test]
    fn test_note_filename_parse_returns_path_traversal_error() {
        let err = NoteFilename::parse("../evil.md").unwrap_err();
        assert!(matches!(err, CoreError::PathTraversal(_)));
    }

    #[test]
    fn test_note_filename_as_str_roundtrip() {
        let f = NoteFilename::parse("note.md").unwrap();
        assert_eq!(f.as_str(), "note.md");
    }
}
