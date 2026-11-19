//! The rules of one glyph image: its name, its format, how large it may be, and the file
//! that holds it. Plain values in and out; the operations beside it touch the disk.

use std::fmt;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::CoreError;
use crate::utils::paths::data_dir;

const GLYPHS_DIR: &str = "glyphs";

/// The limit for one image. Sync bundles the changes into one POST as base64, so allowing
/// a large image makes sync heavy by itself. 256 KiB is more than enough for an
/// emoji-sized symbol.
pub const GLYPH_MAX_BYTES: usize = 256 * 1024;

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

    /// The format a name's image is not in. One name holds one image, so saving in one
    /// format clears the file of the other.
    pub(crate) const fn other(self) -> Self {
        match self {
            Self::Png => Self::Svg,
            Self::Svg => Self::Png,
        }
    }
}

/// One entry of the glyph list. It does not hold the image itself.
#[derive(Debug, Clone, Serialize)]
pub struct GlyphSummary {
    pub name: String,
    pub filename: String,
    pub format: String,
    pub bytes: u64,
}

/// The content of one glyph.
#[derive(Debug, Clone)]
pub struct GlyphData {
    pub format: GlyphFormat,
    pub bytes: Vec<u8>,
}

/// Where special-character (glyph) images live.
///
/// Inside `data/` because the images should sync too. If a note with `:236p:` showed as plain text
/// on another device, registering it would be pointless. The sync scan walks everything under data
/// without selecting by extension.
#[must_use]
pub(crate) fn glyphs_dir(base_dir: &Path) -> PathBuf {
    data_dir(base_dir).join(GLYPHS_DIR)
}

/// The file that holds `name` in `format`: `<name>.<png|svg>`.
pub(crate) fn filename(name: &GlyphName, format: GlyphFormat) -> String {
    format!("{name}.{}", format.extension())
}

/// Split `<name>.<ext>` into name and format. If either does not fit the rules, it is not
/// a glyph (an unrelated file dropped in by hand is silently skipped).
pub(crate) fn summarize_filename(filename: &str) -> Option<(GlyphName, GlyphFormat)> {
    let path = Path::new(filename);
    let name = GlyphName::parse(path.file_stem()?.to_str()?).ok()?;
    let format = GlyphFormat::parse(path.extension()?.to_str()?).ok()?;
    Some((name, format))
}

/// Check that the content is the format it claims. No strict parsing: for PNG only the
/// first 8 bytes, for SVG only that it is UTF-8 and contains `<svg`. Rejecting a file
/// whose extension and content disagree is enough; an XML parser is not worth carrying.
pub(crate) fn validate(format: GlyphFormat, bytes: &[u8]) -> Result<(), CoreError> {
    if bytes.len() > GLYPH_MAX_BYTES {
        return Err(CoreError::Parse(format!(
            "glyph is too large: {} bytes (max {GLYPH_MAX_BYTES})",
            bytes.len()
        )));
    }
    let looks_right = match format {
        GlyphFormat::Png => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        GlyphFormat::Svg => std::str::from_utf8(bytes).is_ok_and(|text| text.contains("<svg")),
    };
    if looks_right {
        Ok(())
    } else {
        Err(CoreError::Parse(format!(
            "content is not a {} image",
            format.extension()
        )))
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

    /// Glyph images are inside `data/` too. They reach the other devices along with the notes.
    #[test]
    fn glyphs_live_inside_the_synced_tree() {
        assert_eq!(
            glyphs_dir(Path::new("/app")),
            PathBuf::from("/app/data/glyphs")
        );
    }
}
