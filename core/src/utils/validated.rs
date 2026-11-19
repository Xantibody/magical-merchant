use std::fmt;

use crate::error::CoreError;

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

#[cfg(test)]
mod tests {
    use super::*;

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
