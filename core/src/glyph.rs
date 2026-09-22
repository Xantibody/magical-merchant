//! Special characters (glyphs). A small image the user registers gets a short name, and
//! writing `:name:` in the body draws it like an emoji. It is for symbols that cannot be
//! typed, such as fighting game command notation (`:236p:`).
//!
//! Images live at `data/glyphs/<name>.<png|svg>` and sync by the same path as notes. The
//! body side stays the string `:name:`; the name is only looked up at draw time, so on a
//! device the image has not reached, it shows as text.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::CoreError;
use crate::utils::fs::{resolve_existing, write_atomic};
use crate::utils::paths::glyphs_dir;
use crate::utils::validated::{GlyphFormat, GlyphName};

/// The limit for one image. Sync bundles the changes into one POST as base64, so allowing
/// a large image makes sync heavy by itself. 256 KiB is more than enough for an
/// emoji-sized symbol.
pub const GLYPH_MAX_BYTES: usize = 256 * 1024;

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

struct Glyphs {
    base_dir: PathBuf,
}

impl Glyphs {
    const fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    fn dir(&self) -> PathBuf {
        glyphs_dir(&self.base_dir)
    }

    fn filename(name: &GlyphName, format: GlyphFormat) -> String {
        format!("{name}.{}", format.extension())
    }

    /// Find the actual file from a name. The format exists only in the filename, so both are tried.
    fn find(&self, name: &GlyphName) -> Result<(PathBuf, GlyphFormat), CoreError> {
        let dir = self.dir();
        for format in [GlyphFormat::Png, GlyphFormat::Svg] {
            match resolve_existing(&dir, &Self::filename(name, format)) {
                Ok(path) => return Ok((path, format)),
                Err(CoreError::NotFound(_)) => {}
                Err(e) => return Err(e),
            }
        }
        Err(CoreError::NotFound(name.to_string()))
    }

    /// The write target for a file that does not exist yet. As with templates, the directory
    /// is resolved first and the validated name joined on.
    fn writable_path(&self, name: &GlyphName, format: GlyphFormat) -> Result<PathBuf, CoreError> {
        let dir = self.dir();
        fs::create_dir_all(&dir)?;
        Ok(fs::canonicalize(&dir)?.join(Self::filename(name, format)))
    }

    fn list(&self) -> Result<Vec<GlyphSummary>, CoreError> {
        let dir = self.dir();
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut glyphs: Vec<GlyphSummary> = fs::read_dir(dir)?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let filename = entry.file_name().to_string_lossy().to_string();
                let (name, format) = summarize_filename(&filename)?;
                let bytes = entry.metadata().ok()?.len();
                Some(GlyphSummary {
                    name: name.as_str().to_string(),
                    filename,
                    format: format.extension().to_string(),
                    bytes,
                })
            })
            .collect();
        // By name. The name is the only handle to find one
        glyphs.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(glyphs)
    }

    fn read(&self, name: &GlyphName) -> Result<GlyphData, CoreError> {
        let (path, format) = self.find(name)?;
        Ok(GlyphData {
            format,
            bytes: fs::read(path)?,
        })
    }

    fn save(&self, name: &GlyphName, format: GlyphFormat, bytes: &[u8]) -> Result<(), CoreError> {
        validate(format, bytes)?;
        let path = self.writable_path(name, format)?;
        write_atomic(&path, bytes)?;

        // One image per name. When a PNG is replaced by an SVG, the old one is deleted:
        // left in place, the reader would have to decide which one `:name:` means
        let other = match format {
            GlyphFormat::Png => GlyphFormat::Svg,
            GlyphFormat::Svg => GlyphFormat::Png,
        };
        match fs::remove_file(self.dir().join(Self::filename(name, other))) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    fn delete(&self, name: &GlyphName) -> Result<(), CoreError> {
        let (path, _) = self.find(name)?;
        fs::remove_file(path)?;
        Ok(())
    }
}

/// Split `<name>.<ext>` into name and format. If either does not fit the rules, it is not
/// a glyph (an unrelated file dropped in by hand is silently skipped).
fn summarize_filename(filename: &str) -> Option<(GlyphName, GlyphFormat)> {
    let path = Path::new(filename);
    let name = GlyphName::parse(path.file_stem()?.to_str()?).ok()?;
    let format = GlyphFormat::parse(path.extension()?.to_str()?).ok()?;
    Some((name, format))
}

/// Check that the content is the format it claims. No strict parsing: for PNG only the
/// first 8 bytes, for SVG only that it is UTF-8 and contains `<svg`. Rejecting a file
/// whose extension and content disagree is enough; an XML parser is not worth carrying.
fn validate(format: GlyphFormat, bytes: &[u8]) -> Result<(), CoreError> {
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

pub fn list_glyphs(base_dir: &Path) -> Result<Vec<GlyphSummary>, CoreError> {
    Glyphs::new(base_dir.to_path_buf()).list()
}

pub fn read_glyph(base_dir: &Path, name: &GlyphName) -> Result<GlyphData, CoreError> {
    Glyphs::new(base_dir.to_path_buf()).read(name)
}

/// Create if missing, overwrite if present. The name is just a name, not an ID, so the
/// caller is free to put a different image under the same name.
pub fn save_glyph(
    base_dir: &Path,
    name: &GlyphName,
    format: GlyphFormat,
    bytes: &[u8],
) -> Result<(), CoreError> {
    Glyphs::new(base_dir.to_path_buf()).save(name, format, bytes)
}

pub fn delete_glyph(base_dir: &Path, name: &GlyphName) -> Result<(), CoreError> {
    Glyphs::new(base_dir.to_path_buf()).delete(name)
}

#[cfg(test)]
mod tests {
    use super::*;
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
    fn the_list_is_sorted_by_name_and_carries_the_size() {
        let tmp = TempDir::new().unwrap();
        save_glyph(tmp.path(), &name("623k"), GlyphFormat::Svg, SVG).unwrap();
        save_glyph(tmp.path(), &name("236p"), GlyphFormat::Png, PNG).unwrap();

        let listed = list_glyphs(tmp.path()).unwrap();

        let names: Vec<&str> = listed.iter().map(|g| g.name.as_str()).collect();
        assert_eq!(names, vec!["236p", "623k"]);
        assert_eq!(listed[0].filename, "236p.png");
        assert_eq!(listed[0].format, "png");
        assert_eq!(listed[0].bytes, PNG.len() as u64);
        assert_eq!(listed[1].format, "svg");
    }

    /// An unrelated file dropped in by hand is not a glyph. Nor is a broken name.
    #[test]
    fn the_list_ignores_files_that_are_not_glyphs() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("data/glyphs");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("readme.txt"), "x").unwrap();
        fs::write(dir.join("Bad Name.png"), PNG).unwrap();
        fs::write(dir.join(".DS_Store"), "x").unwrap();
        fs::write(dir.join("ok.png"), PNG).unwrap();

        let listed = list_glyphs(tmp.path()).unwrap();

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "ok");
    }

    #[test]
    fn an_empty_directory_lists_nothing() {
        let tmp = TempDir::new().unwrap();

        assert!(list_glyphs(tmp.path()).unwrap().is_empty());
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
    fn reading_a_missing_glyph_is_not_found() {
        let tmp = TempDir::new().unwrap();

        let result = read_glyph(tmp.path(), &name("nope"));

        assert!(matches!(result, Err(CoreError::NotFound(_))));
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

    /// Name validation alone can be made to read outside the directory through a link.
    #[test]
    fn a_symlink_out_of_the_directory_is_refused() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("data/glyphs");
        fs::create_dir_all(&dir).unwrap();
        fs::write(tmp.path().join("outside.png"), PNG).unwrap();
        std::os::unix::fs::symlink(tmp.path().join("outside.png"), dir.join("linked.png")).unwrap();

        let result = read_glyph(tmp.path(), &name("linked"));

        assert!(matches!(result, Err(CoreError::PathTraversal(_))));
    }
}
