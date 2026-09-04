//! 特殊文字(グリフ)。ユーザーが登録した小さな画像に短い名前を付け、
//! 本文に `:name:` と書くと絵文字のように描かれる。格闘ゲームの
//! コマンド表記(`:236p:`)のような、文字では書けない記号のためのもの。
//!
//! 画像は `data/glyphs/<name>.<png|svg>` に置き、ノートと同じ経路で同期
//! される。本文側は `:name:` の文字列のままで、描くときに名前を引くだけ —
//! 画像が届いていない端末では文字のまま見える。

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::CoreError;
use crate::utils::fs::{resolve_existing, write_atomic};
use crate::utils::paths::glyphs_dir;
use crate::utils::validated::{GlyphFormat, GlyphName};

/// 1 枚の上限。同期は変更分をまとめて 1 回の POST に base64 で載せるので、
/// 大きな画像を許すとそれだけで同期が重くなる。絵文字大の記号に
/// 256 KiB は十分すぎる。
pub const GLYPH_MAX_BYTES: usize = 256 * 1024;

/// グリフ一覧の 1 件。画像そのものは持たない。
#[derive(Debug, Clone, Serialize)]
pub struct GlyphSummary {
    pub name: String,
    pub filename: String,
    pub format: String,
    pub bytes: u64,
}

/// グリフ 1 枚の中身。
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

    /// 名前から実ファイルを探す。形式はファイル名にしか無いので、両方を試す。
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

    /// まだ無いファイルの書き込み先。テンプレと同じく、置き場を解決してから
    /// 検証済みの名前を繋ぐ。
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
        // 名前順。探す手がかりは名前しかない
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

        // 同じ名前は 1 枚だけ。PNG を SVG で置き換えたら古いほうを消す —
        // 残すと `:name:` がどちらを指すのか読む側で決めることになる
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

/// `<name>.<ext>` を名前と形式に分ける。どちらかが規則に合わなければ
/// グリフではない(手で置かれた無関係なファイルは黙って飛ばす)。
fn summarize_filename(filename: &str) -> Option<(GlyphName, GlyphFormat)> {
    let path = Path::new(filename);
    let name = GlyphName::parse(path.file_stem()?.to_str()?).ok()?;
    let format = GlyphFormat::parse(path.extension()?.to_str()?).ok()?;
    Some((name, format))
}

/// 中身が名乗った形式かを確かめる。厳密な解析はしない — PNG は先頭の
/// 8 バイト、SVG は UTF-8 で `<svg` を含むことだけ。拡張子と中身が食い違う
/// ファイルを弾ければ十分で、XML パーサを抱える価値はない。
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

/// 無ければ作り、あれば上書きする。名前は ID ではなくただの名前なので、
/// 同じ名前で別の画像を入れ直すのは呼ぶ側の自由。
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

    /// グリフは `data/` の中に置く。同期の走査が data 配下を辿るので、
    /// ここを外すと他の端末に画像が届かない。
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

    /// 手で置かれた無関係なファイルはグリフではない。壊れた名前も同じ。
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

    /// 同期に載せる 1 回の POST に丸ごと乗るので、大きさには上限を置く。
    #[test]
    fn an_oversized_image_is_refused() {
        let tmp = TempDir::new().unwrap();
        let mut big = PNG.to_vec();
        big.resize(GLYPH_MAX_BYTES + 1, 0);

        let result = save_glyph(tmp.path(), &name("big"), GlyphFormat::Png, &big);

        assert!(matches!(result, Err(CoreError::Parse(_))));
        assert!(!tmp.path().join("data/glyphs/big.png").exists());
    }

    /// 上限ちょうどは通す。`>=` で弾くと、上限を狙って縮めた画像が入らない。
    #[test]
    fn an_image_of_exactly_the_limit_is_accepted() {
        let tmp = TempDir::new().unwrap();
        let mut big = PNG.to_vec();
        big.resize(GLYPH_MAX_BYTES, 0);

        save_glyph(tmp.path(), &name("big"), GlyphFormat::Png, &big).unwrap();

        let saved = read_glyph(tmp.path(), &name("big")).unwrap();
        assert_eq!(saved.bytes.len(), GLYPH_MAX_BYTES);
    }

    /// 拡張子と中身が食い違うファイルは描けないので、入り口で弾く。
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

    /// 1 つの名前は 1 枚の画像を指す。形式を変えて入れ直したら古いほうは消える。
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

    /// 名前の検証だけでは、リンク越しに置き場の外を読ませられる。
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
