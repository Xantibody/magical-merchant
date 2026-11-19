//! Registering a glyph under a name, and taking it away again.

use std::path::Path;

use super::image::{GlyphFormat, GlyphName, filename, glyphs_dir, validate};
use super::lookup::find;
use crate::services::files::{remove, remove_if_present, resolve_writable, write_atomic};
use crate::utils::error::CoreError;

/// Create if missing, overwrite if present. The name is just a name, not an ID, so the
/// caller is free to put a different image under the same name.
pub fn save_glyph(
    base_dir: &Path,
    name: &GlyphName,
    format: GlyphFormat,
    bytes: &[u8],
) -> Result<(), CoreError> {
    validate(format, bytes)?;
    let dir = glyphs_dir(base_dir);
    let path = resolve_writable(&dir, &filename(name, format))?;
    write_atomic(&path, bytes)?;

    // One image per name. When a PNG is replaced by an SVG, the old one is deleted:
    // left in place, the reader would have to decide which one `:name:` means
    remove_if_present(&dir.join(filename(name, format.other())))
}

pub fn delete_glyph(base_dir: &Path, name: &GlyphName) -> Result<(), CoreError> {
    let (path, _) = find(base_dir, name)?;
    remove(&path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::glyphs::{GLYPH_MAX_BYTES, list_glyphs, read_glyph};
    use tempfile::TempDir;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
    const SVG: &[u8] = b"<svg xmlns=\"http://www.w3.org/2000/svg\"><circle r=\"4\"/></svg>";

    fn name(s: &str) -> GlyphName {
        GlyphName::parse(s).unwrap()
    }

    #[test]
    fn saving_then_reading_round_trips_the_bytes_and_format() {
        let tmp = TempDir::new().unwrap();

        save_glyph(tmp.path(), &name("236p"), GlyphFormat::Png, PNG).unwrap();

        let glyph = read_glyph(tmp.path(), &name("236p")).unwrap();
        assert_eq!(glyph.format, GlyphFormat::Png);
        assert_eq!(glyph.bytes, PNG);
    }

    /// Glyphs live under `data/`. The sync scan walks everything under data, so outside it
    /// an image never reaches other devices.
    #[test]
    fn glyphs_are_written_inside_the_data_directory() {
        let tmp = TempDir::new().unwrap();

        save_glyph(tmp.path(), &name("236p"), GlyphFormat::Svg, SVG).unwrap();

        assert!(tmp.path().join("data/glyphs/236p.svg").exists());
    }

    #[test]
    fn deleting_removes_the_file() {
        let tmp = TempDir::new().unwrap();
        save_glyph(tmp.path(), &name("236p"), GlyphFormat::Png, PNG).unwrap();

        delete_glyph(tmp.path(), &name("236p")).unwrap();

        assert!(!tmp.path().join("data/glyphs/236p.png").exists());
        assert!(list_glyphs(tmp.path()).unwrap().is_empty());
    }

    #[test]
    fn deleting_a_missing_glyph_is_not_found() {
        let tmp = TempDir::new().unwrap();

        let result = delete_glyph(tmp.path(), &name("nope"));

        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }

    /// A name is not an ID: saving under it again puts the new image in place of the old.
    #[test]
    fn saving_again_in_the_same_format_replaces_the_bytes() {
        let tmp = TempDir::new().unwrap();
        let mut second = PNG.to_vec();
        second.extend_from_slice(b"second");
        save_glyph(tmp.path(), &name("236p"), GlyphFormat::Png, PNG).unwrap();

        save_glyph(tmp.path(), &name("236p"), GlyphFormat::Png, &second).unwrap();

        assert_eq!(read_glyph(tmp.path(), &name("236p")).unwrap().bytes, second);
        assert_eq!(list_glyphs(tmp.path()).unwrap().len(), 1);
    }

    /// It rides whole on the one POST that sync sends, so the size has a limit.
    #[test]
    fn an_oversized_image_is_refused() {
        let tmp = TempDir::new().unwrap();
        let mut big = PNG.to_vec();
        big.resize(GLYPH_MAX_BYTES + 1, 0);

        let result = save_glyph(tmp.path(), &name("big"), GlyphFormat::Png, &big);

        assert!(matches!(result, Err(CoreError::Parse(_))));
        assert!(!tmp.path().join("data/glyphs/big.png").exists());
    }

    /// Exactly the limit passes. Rejecting with `>=` would keep out an image shrunk to hit
    /// the limit.
    #[test]
    fn an_image_of_exactly_the_limit_is_accepted() {
        let tmp = TempDir::new().unwrap();
        let mut big = PNG.to_vec();
        big.resize(GLYPH_MAX_BYTES, 0);

        save_glyph(tmp.path(), &name("big"), GlyphFormat::Png, &big).unwrap();

        let saved = read_glyph(tmp.path(), &name("big")).unwrap();
        assert_eq!(saved.bytes.len(), GLYPH_MAX_BYTES);
    }

    /// A file whose extension and content disagree cannot be drawn, so it is rejected at the door.
    #[test]
    fn content_that_is_not_the_named_format_is_refused() {
        let tmp = TempDir::new().unwrap();

        let as_png = save_glyph(tmp.path(), &name("x"), GlyphFormat::Png, SVG);
        let as_svg = save_glyph(tmp.path(), &name("y"), GlyphFormat::Svg, PNG);
        let text = save_glyph(tmp.path(), &name("z"), GlyphFormat::Svg, b"<html>");

        assert!(matches!(as_png, Err(CoreError::Parse(_))));
        assert!(matches!(as_svg, Err(CoreError::Parse(_))));
        assert!(matches!(text, Err(CoreError::Parse(_))));
        assert!(list_glyphs(tmp.path()).unwrap().is_empty());
    }

    /// One name means one image. Re-saved in the other format, the old one is gone.
    #[test]
    fn saving_the_other_format_replaces_the_old_file() {
        let tmp = TempDir::new().unwrap();
        save_glyph(tmp.path(), &name("236p"), GlyphFormat::Png, PNG).unwrap();

        save_glyph(tmp.path(), &name("236p"), GlyphFormat::Svg, SVG).unwrap();

        assert!(!tmp.path().join("data/glyphs/236p.png").exists());
        assert!(tmp.path().join("data/glyphs/236p.svg").exists());
        assert_eq!(list_glyphs(tmp.path()).unwrap().len(), 1);
        assert_eq!(
            read_glyph(tmp.path(), &name("236p")).unwrap().format,
            GlyphFormat::Svg
        );
    }
}
