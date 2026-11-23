//! Looking glyphs up: the list Settings shows, and the image a `:name:` draws.

use std::path::{Path, PathBuf};

use super::image::{
    GlyphData, GlyphFormat, GlyphName, GlyphSummary, filename, glyphs_dir, summarize_filename,
};
use crate::services::files::{self, resolve_existing};
use crate::utils::error::CoreError;

pub fn list_glyphs(base_dir: &Path) -> Result<Vec<GlyphSummary>, CoreError> {
    let mut glyphs: Vec<GlyphSummary> = files::list_entries(&glyphs_dir(base_dir))?
        .into_iter()
        .filter_map(|listed| {
            let (name, format) = summarize_filename(&listed.name)?;
            Some(GlyphSummary {
                name: name.as_str().to_string(),
                filename: listed.name,
                format: format.extension().to_string(),
                bytes: listed.bytes,
            })
        })
        .collect();
    // By name. The name is the only handle to find one
    glyphs.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(glyphs)
}

pub fn read_glyph(base_dir: &Path, name: &GlyphName) -> Result<GlyphData, CoreError> {
    let (path, format) = find(base_dir, name)?;
    Ok(GlyphData {
        format,
        bytes: files::read(&path)?,
    })
}

/// Find the actual file from a name. The format exists only in the filename, so both are tried.
pub(super) fn find(base_dir: &Path, name: &GlyphName) -> Result<(PathBuf, GlyphFormat), CoreError> {
    let dir = glyphs_dir(base_dir);
    for format in [GlyphFormat::Png, GlyphFormat::Svg] {
        match resolve_existing(&dir, &filename(name, format)) {
            Ok(path) => return Ok((path, format)),
            Err(CoreError::NotFound(_)) => {}
            Err(e) => return Err(e),
        }
    }
    Err(CoreError::NotFound(name.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::glyphs::save_glyph;
    use std::fs;
    use tempfile::TempDir;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
    const SVG: &[u8] = b"<svg xmlns=\"http://www.w3.org/2000/svg\"><circle r=\"4\"/></svg>";

    fn name(s: &str) -> GlyphName {
        GlyphName::parse(s).unwrap()
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
    fn reading_a_missing_glyph_is_not_found() {
        let tmp = TempDir::new().unwrap();

        let result = read_glyph(tmp.path(), &name("nope"));

        assert!(matches!(result, Err(CoreError::NotFound(_))));
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
