pub(crate) mod error;
mod history;
mod repair;
pub(crate) mod repository;
mod revision;
mod summary;

pub use history::{Snapshot, list_note_history, read_note_history, restore_note, snapshot_note};
pub(crate) use repository::Notes;
pub use revision::Revision;
pub use summary::Summary as NoteSummary;

use std::path::{Path, PathBuf};

use crate::error::CoreError;
use crate::utils::device::Context;
use crate::utils::frontmatter::{self, Provenance};
use crate::utils::validated::NoteFilename;

/// ノートを 1 本作る。出自([`Provenance`])は作成時にしか書けない記録で、
/// 何も名乗らないなら [`Provenance::default`]。タイムラインエントリの昇格は
/// `origin` を添えた同じ呼び出し — 経路ごとに関数を生やすと、出自の記録が
/// 1 つ増えるたびに全部のシグネチャが壊れる。
pub fn create_draft_note(
    base_dir: &Path,
    body: &str,
    tags: &[String],
    context: &Context,
    provenance: Provenance<'_>,
) -> Result<PathBuf, CoreError> {
    Notes::new(base_dir.to_path_buf()).create(body, tags, context, provenance)
}

/// 本文を書き換える。`expected` に読んだときの [`Revision`] を添えると、
/// そのあいだに本文が変わっていれば [`CoreError::Stale`] で断る。
/// 返るのは書いた本文の revision — 続けて書くときの `expected` になる。
pub fn update_note(
    file_path: &Path,
    body: &str,
    context: &Context,
    expected: Option<&Revision>,
) -> Result<Revision, CoreError> {
    Notes::update(file_path, body, context, expected)
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

/// 表示モードだけを差し替える。`None` で既定(エディタ)に戻す。
/// time / tags / context / 本文には触れない。
pub fn update_note_view(
    base_dir: &Path,
    filename: &NoteFilename,
    view: Option<&str>,
) -> Result<(), CoreError> {
    Notes::new(base_dir.to_path_buf()).update_view(filename, view)
}

/// 昇格元エントリとの繋がりだけを差し替える。`None` で関係を解いて
/// 独立したノートに戻す。time / tags / context / 本文には触れない。
pub fn update_note_origin(
    base_dir: &Path,
    filename: &NoteFilename,
    origin: Option<&str>,
) -> Result<(), CoreError> {
    Notes::new(base_dir.to_path_buf()).update_origin(filename, origin)
}

/// 過去の編集で本文に混入した化けメタデータを直す。直したファイル数を返す。
pub fn repair_notes(base_dir: &Path) -> Result<usize, CoreError> {
    repair::repair_all(&crate::utils::paths::notes_dir(base_dir))
}

/// 古い版が `data/notes/` と `data/timeline/` に置いた競合コピーを `conflicts/` へ
/// 移す。移した件数を返す。
/// 呼ぶのは同期を持つアプリだけ、それも最初の同期より前に一度。
pub fn relocate_conflict_copies(base_dir: &Path) -> Result<usize, CoreError> {
    repair::relocate_conflict_copies(base_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::device::Source;
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

    /// 何も名乗らない普通の新規ノート。作成そのものを見るテスト以外は
    /// これを通す — 出自が 1 つ増えるたびに全テストが書き換わる形にしない。
    fn draft(tmp: &TempDir, body: &str, tags: &[String]) -> Result<PathBuf, CoreError> {
        create_draft_note(
            tmp.path(),
            body,
            tags,
            &mock_context(),
            Provenance::default(),
        )
    }

    #[test]
    fn a_note_promoted_from_an_entry_records_its_origin() {
        let tmp = TempDir::new().unwrap();
        let path = create_draft_note(
            tmp.path(),
            "エントリ本文 #memo",
            &["memo".to_string()],
            &mock_context(),
            promoted_from("2026-08-13T08:30:00"),
        )
        .unwrap();

        let meta = read_note_meta(
            tmp.path(),
            &NoteFilename::parse(path.file_name().unwrap().to_str().unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(meta.origin, Some("2026-08-13T08:30:00".to_string()));

        // 一覧にも乗る。タイムラインのチップはここから導出される
        let listed = list_notes(tmp.path()).unwrap();
        assert_eq!(listed[0].origin, Some("2026-08-13T08:30:00".to_string()));
    }

    #[test]
    fn test_create_draft_note_returns_path() {
        let tmp = TempDir::new().unwrap();
        let path = create_draft_note(
            tmp.path(),
            "draft body",
            &[],
            &mock_context(),
            Provenance::default(),
        )
        .unwrap();
        let content = fs::read_to_string(&path).unwrap();
        // origin はエントリ由来のノートだけの記録。普通の新規ノートに書くと
        // 全ノートが「どこかのエントリから来た」ことになってしまう
        assert!(!content.contains("origin"));
        assert!(path.exists());
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("draft body"));
    }

    /// ファイル名は秒までの時刻。同じ秒に 2 本作っても 1 本目を潰さない。
    /// 2 本目は 1 秒後の名前を取る — 形式(`YYYYMMDD_HHMMSS.md`)は不変。
    #[test]
    fn two_notes_created_in_the_same_second_both_survive() {
        let tmp = TempDir::new().unwrap();

        let first = draft(&tmp, "one", &[]).unwrap();
        let second = draft(&tmp, "two", &[]).unwrap();

        assert_ne!(first, second);
        assert_eq!(read_note(&first).unwrap(), "one");
        assert_eq!(read_note(&second).unwrap(), "two");
        assert_eq!(list_notes(tmp.path()).unwrap().len(), 2);
        assert_eq!(
            stamp_of(&second) - stamp_of(&first),
            chrono::Duration::seconds(1)
        );
    }

    /// ずらした秒はファイル名だけの話ではない。frontmatter の `time` が
    /// 名前とずれると、一覧(名前順)と表示(`time`)で並びが食い違う。
    #[test]
    fn a_shifted_name_carries_the_same_time_in_the_frontmatter() {
        let tmp = TempDir::new().unwrap();
        draft(&tmp, "one", &[]).unwrap();

        let second = draft(&tmp, "two", &[]).unwrap();

        let meta = read_note_meta(tmp.path(), &filename_of(&second)).unwrap();
        assert_eq!(
            meta.time.naive_local().format("%Y%m%d_%H%M%S").to_string(),
            second.file_stem().unwrap().to_str().unwrap()
        );
    }

    fn stamp_of(path: &Path) -> chrono::NaiveDateTime {
        let stem = path.file_stem().unwrap().to_str().unwrap();
        chrono::NaiveDateTime::parse_from_str(stem, "%Y%m%d_%H%M%S").unwrap()
    }

    #[test]
    fn test_update_note_overwrites() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "original", &[]).unwrap();

        update_note(&path, "updated", &mock_context(), None).unwrap();

        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("updated"));
        assert!(!content.contains("original"));
    }

    /// time は作成時刻。一覧はファイル名(作成時刻)順に並ぶので、編集で
    /// time が動くと日付グループと並び順が食い違う。
    #[test]
    fn update_note_keeps_the_creation_time() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "original", &[]).unwrap();
        let original = fs::read_to_string(&path).unwrap();
        let (fm_before, _) = frontmatter::parse::<NoteFrontmatter>(&original).unwrap();

        update_note(&path, "updated", &mock_context(), None).unwrap();

        let updated = fs::read_to_string(&path).unwrap();
        let (fm_after, body) = frontmatter::parse::<NoteFrontmatter>(&updated).unwrap();
        assert_eq!(fm_after.time, fm_before.time);
        assert_eq!(body, "updated");
    }

    /// time が作成時刻に固定されている以上、書き直した事実はどこにも
    /// 残らない。本文の保存だけが updated を打つ。
    #[test]
    fn update_note_stamps_the_updated_time() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "original", &[]).unwrap();
        let filename = filename_of(&path);
        assert_eq!(read_note_meta(tmp.path(), &filename).unwrap().updated, None);

        update_note(&path, "updated", &mock_context(), None).unwrap();

        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        assert!(meta.updated.is_some());
        assert!(meta.updated.unwrap() >= meta.time);
    }

    /// 読んでから書くまでに別の書き手が本文を変えていたら、その上に書かない。
    /// アプリはファイルを監視しないので、外(CLI・MCP)で書き換えたノートを
    /// 開いたまま打つと、古い本文ごと上書きしてしまう。
    #[test]
    fn update_note_refuses_to_overwrite_a_body_that_moved_since_it_was_read() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "original", &[]).unwrap();
        let read = Revision::of(&read_note(&path).unwrap());
        update_note(&path, "someone else", &mock_context(), None).unwrap();

        let result = update_note(&path, "mine", &mock_context(), Some(&read));

        assert!(
            matches!(result, Err(CoreError::Stale(ref name)) if name == filename_of(&path).as_str())
        );
        assert_eq!(read_note(&path).unwrap(), "someone else");
    }

    #[test]
    fn update_note_with_the_current_revision_writes_and_returns_the_next_one() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "original", &[]).unwrap();
        let read = Revision::of(&read_note(&path).unwrap());

        let next = update_note(&path, "mine", &mock_context(), Some(&read)).unwrap();

        assert_eq!(read_note(&path).unwrap(), "mine");
        assert_eq!(next, Revision::of("mine"));
        // 返った revision で続けて書ける
        update_note(&path, "again", &mock_context(), Some(&next)).unwrap();
        assert_eq!(read_note(&path).unwrap(), "again");
    }

    /// 指紋は本文だけから取る。編集中に表示モードを切り替えても、
    /// 自分の保存が「古い」ことにはならない。
    #[test]
    fn a_metadata_edit_does_not_make_the_body_revision_stale() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "original", &[]).unwrap();
        let filename = filename_of(&path);
        let read = Revision::of(&read_note(&path).unwrap());
        update_note_view(tmp.path(), &filename, Some("mindmap")).unwrap();

        update_note(&path, "mine", &mock_context(), Some(&read)).unwrap();

        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.view, Some("mindmap".to_string()));
        assert_eq!(read_note(&path).unwrap(), "mine");
    }

    /// メタデータや表示モードの差し替えは本文を書き直していない。
    /// ここで updated を打つと「編集していないのに更新日が動く」ことになる。
    #[test]
    fn update_note_meta_and_view_do_not_stamp_updated() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "body", &[]).unwrap();
        let filename = filename_of(&path);

        update_note_meta(tmp.path(), &filename, sample_time(), &[]).unwrap();
        update_note_view(tmp.path(), &filename, Some("mindmap")).unwrap();

        assert_eq!(read_note_meta(tmp.path(), &filename).unwrap().updated, None);
    }

    /// 打たれた updated は、その後のメタデータ編集で消えてはいけない。
    #[test]
    fn update_note_meta_keeps_the_updated_time() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "body", &[]).unwrap();
        let filename = filename_of(&path);
        update_note(&path, "edited", &mock_context(), None).unwrap();
        let stamped = read_note_meta(tmp.path(), &filename).unwrap().updated;

        update_note_meta(tmp.path(), &filename, sample_time(), &[]).unwrap();
        update_note_view(tmp.path(), &filename, Some("mindmap")).unwrap();

        assert_eq!(
            read_note_meta(tmp.path(), &filename).unwrap().updated,
            stamped
        );
    }

    /// 書いた入り口は作成時に決まる。CLI で作ったノートはそう名乗る。
    #[test]
    fn a_note_records_the_tool_that_created_it() {
        let tmp = TempDir::new().unwrap();
        let path = create_draft_note(
            tmp.path(),
            "CLI から書いた",
            &[],
            &mock_context(),
            Provenance {
                source: Some(Source::Cli),
                ..Provenance::default()
            },
        )
        .unwrap();

        assert!(fs::read_to_string(&path).unwrap().contains("source: cli"));
        let meta = read_note_meta(tmp.path(), &filename_of(&path)).unwrap();
        assert_eq!(meta.source, Some("cli".to_string()));
    }

    /// 名乗らなければキーは付かない。既存のノートを書き直しても
    /// `source` が生えないのと同じ約束。
    #[test]
    fn a_note_that_names_no_source_has_no_source_key() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "body", &[]).unwrap();

        assert!(!fs::read_to_string(&path).unwrap().contains("source"));
    }

    /// `source` は作成時の記録。別のツールで本文を書き直しても、
    /// 「誰が作ったか」は書き換わらない(`updated_by` は別の問い)。
    #[test]
    fn update_note_keeps_the_creation_source() {
        let tmp = TempDir::new().unwrap();
        let path = create_draft_note(
            tmp.path(),
            "original",
            &[],
            &mock_context(),
            Provenance {
                source: Some(Source::Widget),
                ..Provenance::default()
            },
        )
        .unwrap();

        update_note(&path, "アプリで書き直した", &mock_context(), None).unwrap();

        let meta = read_note_meta(tmp.path(), &filename_of(&path)).unwrap();
        assert_eq!(meta.source, Some("widget".to_string()));
    }

    /// メタデータ編集も表示モードの切り替えも本文を書いていない。
    /// ましてや作成の記録には触れない。
    #[test]
    fn update_note_meta_and_view_do_not_touch_the_source() {
        let tmp = TempDir::new().unwrap();
        let path = create_draft_note(
            tmp.path(),
            "body",
            &[],
            &mock_context(),
            Provenance {
                source: Some(Source::Mcp),
                ..Provenance::default()
            },
        )
        .unwrap();
        let filename = filename_of(&path);

        update_note_meta(tmp.path(), &filename, sample_time(), &["log".to_string()]).unwrap();
        update_note_view(tmp.path(), &filename, Some("mindmap")).unwrap();

        assert_eq!(
            read_note_meta(tmp.path(), &filename).unwrap().source,
            Some("mcp".to_string())
        );
    }

    /// context は「どの端末で書いたか」の記録。別の端末で編集しても
    /// 作成時の記録が上書きされてはいけない。
    #[test]
    fn update_note_keeps_the_creation_context() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "original", &[]).unwrap();

        let other_device = Context {
            battery: Some(1),
            is_charging: Some(true),
            ..Context::default()
        };
        update_note(&path, "updated", &other_device, None).unwrap();

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
        let path = draft(&tmp, "original", &["sync".to_string()]).unwrap();

        update_note(&path, "updated", &mock_context(), None).unwrap();

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
        draft(&tmp, "# Hello\nBody text here", &tags).unwrap();

        let notes = list_notes(tmp.path()).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].tags, vec!["rust", "test"]);
        assert!(notes[0].time.is_some());
        assert!(notes[0].preview.contains("Hello"));
    }

    #[test]
    fn test_read_note() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "full content", &[]).unwrap();
        let content = read_note(&path).unwrap();
        assert!(content.contains("full content"));
    }

    /// 読み取りが返すのは本文だけ。frontmatter を返すと、そのまま
    /// プレビューやエディタに流れてメタデータが画面に出る。
    #[test]
    fn read_note_returns_body_without_frontmatter() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "# Title\nbody", &[]).unwrap();

        assert_eq!(read_note(&path).unwrap(), "# Title\nbody");
    }

    #[test]
    fn read_note_by_filename_returns_body_without_frontmatter() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "# Title\nbody", &[]).unwrap();
        let fname = path.file_name().unwrap().to_str().unwrap();
        let note_filename = NoteFilename::parse(fname).unwrap();

        let content = read_note_by_filename(tmp.path(), &note_filename).unwrap();

        assert_eq!(content, "# Title\nbody");
    }

    #[test]
    fn test_delete_note_success() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "to delete", &[]).unwrap();
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
        let path = draft(&tmp, "readable content", &[]).unwrap();
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
        let path = draft(&tmp, "body", &["sync".to_string()]).unwrap();

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
        let path = draft(&tmp, "body", &["old".to_string()]).unwrap();
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
        let path = draft(&tmp, "# Title\nbody", &[]).unwrap();
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
    fn update_note_view_sets_mindmap() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "body", &[]).unwrap();
        let filename = filename_of(&path);

        update_note_view(tmp.path(), &filename, Some("mindmap")).unwrap();

        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.view, Some("mindmap".to_string()));
    }

    #[test]
    fn update_note_view_none_clears_the_key() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "body", &[]).unwrap();
        let filename = filename_of(&path);
        update_note_view(tmp.path(), &filename, Some("mindmap")).unwrap();

        update_note_view(tmp.path(), &filename, None).unwrap();

        assert!(!fs::read_to_string(&path).unwrap().contains("view"));
    }

    /// 表示モードの切り替えで本文とメタデータの記録が動いてはいけない。
    #[test]
    fn update_note_view_keeps_body_time_and_context() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "# Title\nbody", &[]).unwrap();
        let filename = filename_of(&path);
        let before = read_note_meta(tmp.path(), &filename).unwrap();

        update_note_view(tmp.path(), &filename, Some("mindmap")).unwrap();

        assert_eq!(read_note(&path).unwrap(), "# Title\nbody");
        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.time, before.time);
        assert_eq!(meta.context.unwrap().battery, Some(50));
    }

    /// 本文の保存で表示モードが消えると、開き直すたびにエディタへ戻ってしまう。
    #[test]
    fn update_note_keeps_the_view_mode() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "original", &[]).unwrap();
        let filename = filename_of(&path);
        update_note_view(tmp.path(), &filename, Some("mindmap")).unwrap();

        update_note(&path, "updated", &mock_context(), None).unwrap();

        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.view, Some("mindmap".to_string()));
    }

    /// time/tags の編集でも表示モードは保たれる。
    #[test]
    fn update_note_meta_keeps_the_view_mode() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "body", &[]).unwrap();
        let filename = filename_of(&path);
        update_note_view(tmp.path(), &filename, Some("mindmap")).unwrap();

        update_note_meta(tmp.path(), &filename, sample_time(), &[]).unwrap();

        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.view, Some("mindmap".to_string()));
    }

    fn promoted_from(origin: &str) -> Provenance<'_> {
        Provenance {
            origin: Some(origin),
            ..Provenance::default()
        }
    }

    fn promoted_note(tmp: &TempDir) -> NoteFilename {
        let path = create_draft_note(
            tmp.path(),
            "エントリ本文",
            &[],
            &mock_context(),
            promoted_from("2026-08-13T08:30:00"),
        )
        .unwrap();
        filename_of(&path)
    }

    #[test]
    fn update_note_origin_none_clears_the_key() {
        let tmp = TempDir::new().unwrap();
        let filename = promoted_note(&tmp);

        update_note_origin(tmp.path(), &filename, None).unwrap();

        let content =
            fs::read_to_string(tmp.path().join("data/notes").join(filename.as_str())).unwrap();
        assert!(!content.contains("origin"));
    }

    /// 解除は関係を断つだけで、ノートそのものの記録には触れない。
    #[test]
    fn update_note_origin_keeps_body_time_and_context() {
        let tmp = TempDir::new().unwrap();
        let filename = promoted_note(&tmp);
        let before = read_note_meta(tmp.path(), &filename).unwrap();

        update_note_origin(tmp.path(), &filename, None).unwrap();

        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.time, before.time);
        assert_eq!(meta.context.unwrap().battery, Some(50));
        assert!(
            read_note_by_filename(tmp.path(), &filename)
                .unwrap()
                .contains("エントリ本文")
        );
    }

    /// Undo(繋ぎ直し)の経路。解除した値をそのまま書き戻せる。
    #[test]
    fn update_note_origin_restores_the_link() {
        let tmp = TempDir::new().unwrap();
        let filename = promoted_note(&tmp);
        update_note_origin(tmp.path(), &filename, None).unwrap();

        update_note_origin(tmp.path(), &filename, Some("2026-08-13T08:30:00")).unwrap();

        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.origin, Some("2026-08-13T08:30:00".to_string()));
    }

    #[test]
    fn update_note_origin_not_found() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("data/notes")).unwrap();
        let filename = NoteFilename::parse("nonexistent.md").unwrap();

        let result = update_note_origin(tmp.path(), &filename, None);

        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }

    /// 本文の保存で昇格元との繋がりが消えると、タイムラインのチップが
    /// 編集のたびに消えてしまう。
    #[test]
    fn update_note_keeps_the_origin() {
        let tmp = TempDir::new().unwrap();
        let filename = promoted_note(&tmp);
        let path = tmp.path().join("data/notes").join(filename.as_str());

        update_note(&path, "書き直した本文", &mock_context(), None).unwrap();

        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.origin, Some("2026-08-13T08:30:00".to_string()));
    }

    #[test]
    fn update_note_view_not_found() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("data/notes")).unwrap();
        let filename = NoteFilename::parse("nonexistent.md").unwrap();

        let result = update_note_view(tmp.path(), &filename, Some("mindmap"));

        assert!(matches!(result, Err(CoreError::NotFound(_))));
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
