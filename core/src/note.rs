pub(crate) mod error;
mod repair;
pub(crate) mod repository;
mod summary;

pub(crate) use repository::Notes;
pub use summary::Summary as NoteSummary;

use std::path::{Path, PathBuf};

use crate::error::CoreError;
use crate::utils::device::Context;
use crate::utils::frontmatter;
use crate::utils::validated::NoteFilename;

pub fn create_draft_note(
    base_dir: &Path,
    body: &str,
    tags: &[String],
    context: &Context,
) -> Result<PathBuf, CoreError> {
    Notes::new(base_dir.to_path_buf()).create(body, tags, context)
}

pub fn update_note(file_path: &Path, body: &str, context: &Context) -> Result<(), CoreError> {
    Notes::update(file_path, body, context)
}

pub fn list_notes(base_dir: &Path) -> Result<Vec<NoteSummary>, CoreError> {
    Notes::new(base_dir.to_path_buf()).list()
}

/// ノートの本文を返す。frontmatter は保存形式の都合であって、
/// 読む側(プレビュー・エディタ・MCP)に見せるものではない。
pub fn read_note(file_path: &Path) -> Result<String, CoreError> {
    let content = std::fs::read_to_string(file_path)?;
    Ok(frontmatter::strip(&content).to_string())
}

pub fn read_note_by_filename(
    base_dir: &Path,
    filename: &NoteFilename,
) -> Result<String, CoreError> {
    Notes::new(base_dir.to_path_buf()).read(filename)
}

pub fn delete_note(base_dir: &Path, filename: &NoteFilename) -> Result<(), CoreError> {
    Notes::new(base_dir.to_path_buf()).delete(filename)
}

/// frontmatter を 1 件ぶんそのまま返す。`NoteSummary` は一覧向けの要約
/// (本文プレビュー入り・タグは本文の `#記法` と合流済み)で、こちらは
/// メタデータ編集パネルが見る「ファイルに書いてある記録」そのもの。
pub fn read_note_meta(
    base_dir: &Path,
    filename: &NoteFilename,
) -> Result<frontmatter::NoteFrontmatter, CoreError> {
    Notes::new(base_dir.to_path_buf()).read_meta(filename)
}

/// time と tags だけを差し替える。本文はもちろん、context も「どの端末で
/// 書いたか」の記録なので編集の対象にしない。
pub fn update_note_meta(
    base_dir: &Path,
    filename: &NoteFilename,
    time: chrono::DateTime<chrono::FixedOffset>,
    tags: &[String],
) -> Result<(), CoreError> {
    Notes::new(base_dir.to_path_buf()).update_meta(filename, time, tags)
}

/// 過去の編集で本文に混入した化けメタデータを直す。直したファイル数を返す。
pub fn repair_notes(base_dir: &Path) -> Result<usize, CoreError> {
    repair::repair_all(&crate::utils::paths::notes_dir(base_dir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::frontmatter::NoteFrontmatter;
    use std::fs;
    use tempfile::TempDir;

    fn mock_context() -> Context {
        Context {
            battery: Some(50),
            is_charging: Some(false),
            ..Context::default()
        }
    }

    #[test]
    fn test_create_draft_note_returns_path() {
        let tmp = TempDir::new().unwrap();
        let path = create_draft_note(tmp.path(), "draft body", &[], &mock_context()).unwrap();
        assert!(path.exists());
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("draft body"));
    }

    #[test]
    fn test_update_note_overwrites() {
        let tmp = TempDir::new().unwrap();
        let path = create_draft_note(tmp.path(), "original", &[], &mock_context()).unwrap();

        update_note(&path, "updated", &mock_context()).unwrap();

        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("updated"));
        assert!(!content.contains("original"));
    }

    /// time は作成時刻。一覧はファイル名(作成時刻)順に並ぶので、編集で
    /// time が動くと日付グループと並び順が食い違う。
    #[test]
    fn update_note_keeps_the_creation_time() {
        let tmp = TempDir::new().unwrap();
        let path = create_draft_note(tmp.path(), "original", &[], &mock_context()).unwrap();
        let original = fs::read_to_string(&path).unwrap();
        let (fm_before, _) = frontmatter::parse::<NoteFrontmatter>(&original).unwrap();

        update_note(&path, "updated", &mock_context()).unwrap();

        let updated = fs::read_to_string(&path).unwrap();
        let (fm_after, body) = frontmatter::parse::<NoteFrontmatter>(&updated).unwrap();
        assert_eq!(fm_after.time, fm_before.time);
        assert_eq!(body, "updated");
    }

    /// context は「どの端末で書いたか」の記録。別の端末で編集しても
    /// 作成時の記録が上書きされてはいけない。
    #[test]
    fn update_note_keeps_the_creation_context() {
        let tmp = TempDir::new().unwrap();
        let path = create_draft_note(tmp.path(), "original", &[], &mock_context()).unwrap();

        let other_device = Context {
            battery: Some(1),
            is_charging: Some(true),
            ..Context::default()
        };
        update_note(&path, "updated", &other_device).unwrap();

        let updated = fs::read_to_string(&path).unwrap();
        let (fm, _) = frontmatter::parse::<NoteFrontmatter>(&updated).unwrap();
        let ctx = fm.context.unwrap();
        assert_eq!(ctx.battery, Some(50));
        assert_eq!(ctx.is_charging, Some(false));
    }

    /// タグ欄で付けていた頃のノートを編集しても、分類は消えてはいけない。
    #[test]
    fn update_note_keeps_tags_that_predate_the_hash_syntax() {
        let tmp = TempDir::new().unwrap();
        let path = create_draft_note(
            tmp.path(),
            "original",
            &["sync".to_string()],
            &mock_context(),
        )
        .unwrap();

        update_note(&path, "updated", &mock_context()).unwrap();

        assert!(fs::read_to_string(&path).unwrap().contains("sync"));
    }

    #[test]
    fn test_list_notes_empty() {
        let tmp = TempDir::new().unwrap();
        let notes = list_notes(tmp.path()).unwrap();
        assert!(notes.is_empty());
    }

    #[test]
    fn test_list_notes_returns_summaries() {
        let tmp = TempDir::new().unwrap();
        let tags = vec!["rust".to_string(), "test".to_string()];
        create_draft_note(
            tmp.path(),
            "# Hello\nBody text here",
            &tags,
            &mock_context(),
        )
        .unwrap();

        let notes = list_notes(tmp.path()).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].tags, vec!["rust", "test"]);
        assert!(notes[0].time.is_some());
        assert!(notes[0].preview.contains("Hello"));
    }

    #[test]
    fn test_read_note() {
        let tmp = TempDir::new().unwrap();
        let path = create_draft_note(tmp.path(), "full content", &[], &mock_context()).unwrap();
        let content = read_note(&path).unwrap();
        assert!(content.contains("full content"));
    }

    /// 読み取りが返すのは本文だけ。frontmatter を返すと、そのまま
    /// プレビューやエディタに流れてメタデータが画面に出る。
    #[test]
    fn read_note_returns_body_without_frontmatter() {
        let tmp = TempDir::new().unwrap();
        let path = create_draft_note(tmp.path(), "# Title\nbody", &[], &mock_context()).unwrap();

        assert_eq!(read_note(&path).unwrap(), "# Title\nbody");
    }

    #[test]
    fn read_note_by_filename_returns_body_without_frontmatter() {
        let tmp = TempDir::new().unwrap();
        let path = create_draft_note(tmp.path(), "# Title\nbody", &[], &mock_context()).unwrap();
        let fname = path.file_name().unwrap().to_str().unwrap();
        let note_filename = NoteFilename::parse(fname).unwrap();

        let content = read_note_by_filename(tmp.path(), &note_filename).unwrap();

        assert_eq!(content, "# Title\nbody");
    }

    #[test]
    fn test_delete_note_success() {
        let tmp = TempDir::new().unwrap();
        let path = create_draft_note(tmp.path(), "to delete", &[], &mock_context()).unwrap();
        assert!(path.exists());
        let fname = path.file_name().unwrap().to_str().unwrap();
        let note_filename = NoteFilename::parse(fname).unwrap();
        delete_note(tmp.path(), &note_filename).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn test_delete_note_not_found() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("data/notes")).unwrap();
        let note_filename = NoteFilename::parse("nonexistent.md").unwrap();
        let result = delete_note(tmp.path(), &note_filename);
        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }

    #[test]
    fn test_delete_note_path_traversal() {
        assert!(NoteFilename::parse("../etc/passwd").is_err());
    }

    #[test]
    fn test_delete_note_rejects_absolute_path() {
        assert!(NoteFilename::parse("/tmp/evil.md").is_err());
    }

    #[test]
    fn test_read_note_by_filename() {
        let tmp = TempDir::new().unwrap();
        let path = create_draft_note(tmp.path(), "readable content", &[], &mock_context()).unwrap();
        let fname = path.file_name().unwrap().to_str().unwrap();
        let note_filename = NoteFilename::parse(fname).unwrap();
        let content = read_note_by_filename(tmp.path(), &note_filename).unwrap();
        assert!(content.contains("readable content"));
    }

    #[test]
    fn test_read_note_by_filename_path_traversal() {
        assert!(NoteFilename::parse("../etc/passwd").is_err());
    }

    #[test]
    fn test_read_note_by_filename_not_found() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("data/notes")).unwrap();
        let note_filename = NoteFilename::parse("nonexistent.md").unwrap();
        let result = read_note_by_filename(tmp.path(), &note_filename);
        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }

    #[test]
    fn test_validate_rejects_non_md_extension() {
        assert!(NoteFilename::parse("evil.txt").is_err());
    }

    fn filename_of(path: &Path) -> NoteFilename {
        NoteFilename::parse(path.file_name().unwrap().to_str().unwrap()).unwrap()
    }

    fn sample_time() -> chrono::DateTime<chrono::FixedOffset> {
        use chrono::TimeZone as _;
        chrono::FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 5, 3, 15, 39, 0)
            .unwrap()
    }

    #[test]
    fn read_note_meta_returns_time_tags_and_context() {
        let tmp = TempDir::new().unwrap();
        let path =
            create_draft_note(tmp.path(), "body", &["sync".to_string()], &mock_context()).unwrap();

        let meta = read_note_meta(tmp.path(), &filename_of(&path)).unwrap();

        assert_eq!(meta.tags, vec!["sync"]);
        assert_eq!(meta.context.unwrap().battery, Some(50));
    }

    #[test]
    fn read_note_meta_not_found() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("data/notes")).unwrap();
        let filename = NoteFilename::parse("nonexistent.md").unwrap();

        let result = read_note_meta(tmp.path(), &filename);

        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }

    #[test]
    fn update_note_meta_replaces_time_and_tags() {
        let tmp = TempDir::new().unwrap();
        let path =
            create_draft_note(tmp.path(), "body", &["old".to_string()], &mock_context()).unwrap();
        let filename = filename_of(&path);

        update_note_meta(tmp.path(), &filename, sample_time(), &["log".to_string()]).unwrap();

        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.time, sample_time());
        assert_eq!(meta.tags, vec!["log"]);
    }

    /// メタデータの編集で本文が動いてはいけない。逆(本文編集がメタデータを
    /// 保つ)は `update_note` 側のテストが見ている。
    #[test]
    fn update_note_meta_keeps_body_and_context() {
        let tmp = TempDir::new().unwrap();
        let path =
            create_draft_note(tmp.path(), "# Title\nbody", &[], &mock_context()).unwrap();
        let filename = filename_of(&path);

        update_note_meta(tmp.path(), &filename, sample_time(), &[]).unwrap();

        assert_eq!(read_note(&path).unwrap(), "# Title\nbody");
        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.context.unwrap().battery, Some(50));
    }

    /// frontmatter が読めないファイルに time/tags をでっち上げて書き込むと、
    /// 壊れた記録が正当なものに見えてしまう。書かずに断る。
    #[test]
    fn update_note_meta_rejects_broken_frontmatter() {
        let tmp = TempDir::new().unwrap();
        let notes_dir = tmp.path().join("data/notes");
        fs::create_dir_all(&notes_dir).unwrap();
        let broken = "---\ntime: [broken\n---\nbody";
        fs::write(notes_dir.join("20260101_120000.md"), broken).unwrap();
        let filename = NoteFilename::parse("20260101_120000.md").unwrap();

        let result = update_note_meta(tmp.path(), &filename, sample_time(), &[]);

        assert!(matches!(result, Err(CoreError::Parse(_))));
        let content = fs::read_to_string(notes_dir.join("20260101_120000.md")).unwrap();
        assert_eq!(content, broken);
    }

    #[test]
    fn update_note_meta_not_found() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("data/notes")).unwrap();
        let filename = NoteFilename::parse("nonexistent.md").unwrap();

        let result = update_note_meta(tmp.path(), &filename, sample_time(), &[]);

        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }
}
