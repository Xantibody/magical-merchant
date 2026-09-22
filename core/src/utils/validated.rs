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

/// The name of a glyph (special-character image). The `236p` part of `:236p:`.
///
/// Up to 32 characters, starting with a lowercase letter or digit; only `a-z 0-9 _ + -`
/// are allowed. Because it is searched for as `:name:` in the body, `:` `.` `/` and
/// whitespace cannot be in the name. Uppercase is rejected because on some platforms
/// `:236P:` and `:236p:` are different files and on others they are not, and sync
/// collides. `NoteFilename` is not used because it requires `.md`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlyphName(String);

/// The name limit. It is typed into the body between `:`, and nobody wants to type a long one.
const GLYPH_NAME_MAX: usize = 32;

impl GlyphName {
    pub fn parse(s: &str) -> Result<Self, CoreError> {
        let mut chars = s.chars();
        let head_ok = chars
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
        let tail_ok =
            chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "_+-".contains(c));
        if !head_ok || !tail_ok || s.len() > GLYPH_NAME_MAX {
            return Err(CoreError::PathTraversal(s.to_string()));
        }
        Ok(Self(s.to_string()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for GlyphName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// The glyph image format. Decides the file extension and the MIME written in the data URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlyphFormat {
    Png,
    Svg,
}

impl GlyphFormat {
    pub fn parse(s: &str) -> Result<Self, CoreError> {
        match s {
            "png" => Ok(Self::Png),
            "svg" => Ok(Self::Svg),
            other => Err(CoreError::Parse(format!(
                "unsupported glyph format: {other} (png or svg)"
            ))),
        }
    }

    #[must_use]
    pub const fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Svg => "svg",
        }
    }

    #[must_use]
    pub const fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Svg => "image/svg+xml",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glyph_names_are_lowercase_alphanumerics_with_a_few_symbols() {
        assert!(GlyphName::parse("236p").is_ok());
        assert!(GlyphName::parse("a").is_ok());
        assert!(GlyphName::parse("dp+k").is_ok());
        assert!(GlyphName::parse("hcb_p-2").is_ok());
    }

    /// Unless the character set matches the rule that finds `:name:` in the body, a
    /// name could be registered yet never rendered.
    #[test]
    fn glyph_names_refuse_what_the_shortcode_cannot_carry() {
        assert!(GlyphName::parse("").is_err());
        assert!(GlyphName::parse("236P").is_err());
        assert!(GlyphName::parse("_lead").is_err());
        assert!(GlyphName::parse("a.b").is_err());
        assert!(GlyphName::parse("a/b").is_err());
        assert!(GlyphName::parse("a\\b").is_err());
        assert!(GlyphName::parse("a b").is_err());
        assert!(GlyphName::parse("a:b").is_err());
        assert!(GlyphName::parse("a\0b").is_err());
        assert!(GlyphName::parse("..").is_err());
        assert!(GlyphName::parse("日本").is_err());
        assert!(GlyphName::parse(&"a".repeat(33)).is_err());
        assert!(GlyphName::parse(&"a".repeat(32)).is_ok());
    }

    #[test]
    fn glyph_formats_know_their_extension_and_mime() {
        assert_eq!(GlyphFormat::parse("png").unwrap(), GlyphFormat::Png);
        assert_eq!(GlyphFormat::Png.extension(), "png");
        assert_eq!(GlyphFormat::Png.mime(), "image/png");
        assert_eq!(GlyphFormat::Svg.extension(), "svg");
        assert_eq!(GlyphFormat::Svg.mime(), "image/svg+xml");
        assert!(GlyphFormat::parse("gif").is_err());
        assert!(GlyphFormat::parse("PNG").is_err());
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
