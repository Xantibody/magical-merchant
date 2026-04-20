use std::fmt;

use crate::error::CoreError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Slug(String);

impl Slug {
    pub fn parse(s: &str) -> Result<Self, CoreError> {
        if s.is_empty()
            || !s
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            || s.starts_with('-')
            || s.ends_with('-')
        {
            return Err(CoreError::InvalidSlug(s.to_string()));
        }
        Ok(Self(s.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Slug {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Filename(String);

impl Filename {
    pub fn parse(s: &str) -> Result<Self, CoreError> {
        if s.is_empty()
            || s.contains('/')
            || s.contains('\\')
            || s.contains('\0')
            || s.contains("..")
        {
            return Err(CoreError::PathTraversal(s.to_string()));
        }
        Ok(Self(s.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Filename {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

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

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for NoteFilename {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_slug_parse_valid() {
        assert!(Slug::parse("my-project").is_ok());
        assert!(Slug::parse("project123").is_ok());
        assert!(Slug::parse("a").is_ok());
        assert!(Slug::parse("abc-def-123").is_ok());
    }

    #[test]
    fn test_slug_parse_invalid() {
        assert!(Slug::parse("").is_err());
        assert!(Slug::parse("My-Project").is_err());
        assert!(Slug::parse("-start").is_err());
        assert!(Slug::parse("end-").is_err());
        assert!(Slug::parse("has space").is_err());
        assert!(Slug::parse("under_score").is_err());
    }

    #[test]
    fn test_slug_parse_returns_invalid_slug_error() {
        let err = Slug::parse("Bad Slug").unwrap_err();
        assert!(matches!(err, CoreError::InvalidSlug(_)));
    }

    #[test]
    fn test_slug_as_str_roundtrip() {
        let slug = Slug::parse("foo").unwrap();
        assert_eq!(slug.as_str(), "foo");
    }

    #[test]
    fn test_slug_display() {
        let slug = Slug::parse("my-project").unwrap();
        assert_eq!(format!("{slug}"), "my-project");
    }

    // Filename tests

    #[test]
    fn test_filename_parse_valid() {
        assert!(Filename::parse("20260101_120000.md").is_ok());
        assert!(Filename::parse("task.md").is_ok());
        assert!(Filename::parse("some-file.txt").is_ok());
    }

    #[test]
    fn test_filename_parse_invalid() {
        assert!(Filename::parse("").is_err());
        assert!(Filename::parse("../evil.md").is_err());
        assert!(Filename::parse("foo/bar.md").is_err());
        assert!(Filename::parse("foo\\bar.md").is_err());
        assert!(Filename::parse("foo\0bar.md").is_err());
        assert!(Filename::parse("../../etc/passwd").is_err());
    }

    #[test]
    fn test_filename_parse_returns_path_traversal_error() {
        let err = Filename::parse("../evil").unwrap_err();
        assert!(matches!(err, CoreError::PathTraversal(_)));
    }

    #[test]
    fn test_filename_as_str_roundtrip() {
        let f = Filename::parse("task.md").unwrap();
        assert_eq!(f.as_str(), "task.md");
    }

    // NoteFilename tests

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
