//! ノートを書き換える前の全文の控え。
//!
//! 人が画面で書き直すぶんには要らない — 目の前で消えるのは自分の字だけ。
//! 外部(MCP)からの書き換えは本人が見ていないところで起きるので、
//! 「戻れる」ことが書かせる条件になる。
//!
//! 置き場は `data/` の外。同期に載せると、書き換えのたびに控えが端末を
//! 往復し、控えの控えが増える。派生物ではなく退避なので `places.json` とは
//! 違って壊れていても作り直せないが、失って困るのは戻したいときだけで、
//! そのときはノート本体が残っている。

use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Local, NaiveDateTime};
use serde::Serialize;

use crate::error::CoreError;
use crate::utils::fs::{ensure_dir, list_md_files, resolve_existing, write_atomic};
use crate::utils::paths::{history_dir, notes_dir};
use crate::utils::validated::NoteFilename;

/// 控え 1 件。`id` がそのまま `restore` の引数。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Snapshot {
    /// `YYYYMMDD_HHMMSS`、同じ秒に 2 つ目以降は `-2` `-3` と続く。
    pub id: String,
    /// 控えを取った時刻。ノートの `time`(作成)とも `updated`(最後の編集)とも
    /// 別で、「この中身が最後に有効だった瞬間」。
    pub time: DateTime<Local>,
    pub bytes: u64,
}

fn note_history_dir(base_dir: &Path, filename: &NoteFilename) -> PathBuf {
    history_dir(base_dir).join(filename.as_str().trim_end_matches(".md"))
}

/// 控えの名前として通るのは日時とその枝番だけ。`..` や `/` を含む id で
/// 履歴の外を読み書きさせない。
fn snapshot_path(dir: &Path, id: &str) -> Result<PathBuf, CoreError> {
    let (stamp, suffix) = id.split_once('-').unwrap_or((id, "1"));
    let well_formed = NaiveDateTime::parse_from_str(stamp, "%Y%m%d_%H%M%S").is_ok()
        && !suffix.is_empty()
        && suffix.bytes().all(|b| b.is_ascii_digit());
    if !well_formed {
        return Err(CoreError::PathTraversal(id.to_string()));
    }
    Ok(dir.join(format!("{id}.md")))
}

/// いまの全文を控えに取る。ノートがまだ無ければ何も取らず `None`。
///
/// frontmatter ごと丸写しにする。本文だけ残して戻すと、戻した瞬間の
/// メタデータが「書き換える前」を名乗ることになる。
pub fn snapshot_note(
    base_dir: &Path,
    filename: &NoteFilename,
) -> Result<Option<Snapshot>, CoreError> {
    let path = match resolve_existing(&notes_dir(base_dir), filename.as_str()) {
        Ok(path) => path,
        Err(CoreError::NotFound(_)) => return Ok(None),
        Err(e) => return Err(e),
    };
    let content = fs::read_to_string(&path)?;
    let dir = note_history_dir(base_dir, filename);
    let now = Local::now();
    let stamp = now.format("%Y%m%d_%H%M%S").to_string();

    // 同じ秒に 2 回書き換えても前の控えを潰さない。戻したいのは大抵、
    // 立て続けに間違えた直前の 1 つ。
    let mut id = stamp.clone();
    let mut n = 1;
    while dir.join(format!("{id}.md")).exists() {
        n += 1;
        id = format!("{stamp}-{n}");
    }
    let target = dir.join(format!("{id}.md"));
    ensure_dir(&target)?;
    write_atomic(&target, &content)?;
    Ok(Some(Snapshot {
        id,
        time: now,
        bytes: content.len() as u64,
    }))
}

/// 並べるための (秒, 枝番) の組。枝番だけは数として比べる — 文字列のままだと
/// 同じ秒の 2 桁目が来た時点で `-10` が `-2` より前に落ちる。
///
/// 枝番はゼロ埋めしない。名前が桁で変わると、既に置かれている控えの id が
/// 過去のものと今のもので 2 通りになる。並べる側だけを直せば名前は不変。
fn sort_key(id: &str) -> (&str, u32) {
    let (stamp, suffix) = id.split_once('-').unwrap_or((id, "1"));
    (stamp, suffix.parse().unwrap_or(0))
}

/// 新しいものから順に。
pub fn list_note_history(
    base_dir: &Path,
    filename: &NoteFilename,
) -> Result<Vec<Snapshot>, CoreError> {
    let dir = note_history_dir(base_dir, filename);
    let mut snapshots: Vec<Snapshot> = list_md_files(&dir)?
        .into_iter()
        .filter_map(|entry| {
            let name = entry.file_name();
            let id = Path::new(&name).file_stem()?.to_str()?.to_string();
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some(Snapshot {
                id,
                time: modified.into(),
                bytes: entry.metadata().ok()?.len(),
            })
        })
        .collect();
    // id は時刻そのものなので、名前順が時刻順。mtime はコピー先の時刻で、
    // 同じ秒の枝番を並べ替える力はない。
    snapshots.sort_by(|a, b| sort_key(&b.id).cmp(&sort_key(&a.id)));
    Ok(snapshots)
}

/// 控えの全文。読む側が本文だけ欲しければ frontmatter を剥がす。
pub fn read_note_history(
    base_dir: &Path,
    filename: &NoteFilename,
    id: &str,
) -> Result<String, CoreError> {
    let path = snapshot_path(&note_history_dir(base_dir, filename), id)?;
    if !path.exists() {
        return Err(CoreError::NotFound(path.to_string_lossy().to_string()));
    }
    Ok(fs::read_to_string(path)?)
}

/// 控えの中身をノートに書き戻す。戻す前にいまの全文も控えに取るので、
/// 戻したこと自体も戻せる。
pub fn restore_note(
    base_dir: &Path,
    filename: &NoteFilename,
    id: &str,
) -> Result<Option<Snapshot>, CoreError> {
    let content = read_note_history(base_dir, filename, id)?;
    let before = snapshot_note(base_dir, filename)?;
    let target = notes_dir(base_dir).join(filename.as_str());
    ensure_dir(&target)?;
    write_atomic(&target, content)?;
    Ok(before)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::device::Context;
    use crate::utils::frontmatter::{self, NoteFrontmatter, Provenance};
    use crate::{create_draft_note, read_note_by_filename, update_note};
    use tempfile::TempDir;

    fn note(base: &Path, body: &str) -> (PathBuf, NoteFilename) {
        let path =
            create_draft_note(base, body, &[], &Context::default(), Provenance::default()).unwrap();
        let filename = NoteFilename::parse(path.file_name().unwrap().to_str().unwrap()).unwrap();
        (path, filename)
    }

    #[test]
    fn a_note_that_does_not_exist_leaves_nothing_behind() {
        let tmp = TempDir::new().unwrap();
        let filename = NoteFilename::parse("20260101_000000.md").unwrap();

        assert_eq!(snapshot_note(tmp.path(), &filename).unwrap(), None);
        assert!(list_note_history(tmp.path(), &filename).unwrap().is_empty());
    }

    /// 控えは本文ではなくファイルそのもの。frontmatter が欠けた控えを戻すと、
    /// 作成時刻とタグが消える。
    #[test]
    fn a_snapshot_is_the_whole_file_frontmatter_included() {
        let tmp = TempDir::new().unwrap();
        let (path, filename) = note(tmp.path(), "before");

        let snap = snapshot_note(tmp.path(), &filename).unwrap().unwrap();

        let stored = read_note_history(tmp.path(), &filename, &snap.id).unwrap();
        assert_eq!(stored, fs::read_to_string(&path).unwrap());
        assert!(stored.starts_with("---\n"));
    }

    #[test]
    fn restoring_brings_the_old_body_back_and_keeps_a_way_back() {
        let tmp = TempDir::new().unwrap();
        let (path, filename) = note(tmp.path(), "before");
        let snap = snapshot_note(tmp.path(), &filename).unwrap().unwrap();
        update_note(&path, "after", &Context::default(), None).unwrap();

        let undo = restore_note(tmp.path(), &filename, &snap.id)
            .unwrap()
            .unwrap();

        assert_eq!(
            read_note_by_filename(tmp.path(), &filename).unwrap(),
            "before"
        );
        // 戻す直前の「after」も控えに残っている
        let content = read_note_history(tmp.path(), &filename, &undo.id).unwrap();
        assert!(content.ends_with("after"));
    }

    /// 同じ秒に 2 回書き換えたとき、1 回目の控えが 2 回目に潰されない。
    #[test]
    fn two_snapshots_in_the_same_second_both_survive() {
        let tmp = TempDir::new().unwrap();
        let (path, filename) = note(tmp.path(), "one");

        let first = snapshot_note(tmp.path(), &filename).unwrap().unwrap();
        update_note(&path, "two", &Context::default(), None).unwrap();
        let second = snapshot_note(tmp.path(), &filename).unwrap().unwrap();

        assert_ne!(first.id, second.id);
        let history = list_note_history(tmp.path(), &filename).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].id, second.id, "newest first");
        assert!(
            read_note_history(tmp.path(), &filename, &first.id)
                .unwrap()
                .ends_with("one")
        );
    }

    /// 枝番が 2 桁に届くと文字列順が時刻順から外れる(`-10` < `-2`)。
    /// 一覧の先頭は「戻したい直前の 1 つ」なので、そこが入れ替わると
    /// 復元の既定の候補が 9 個前の控えになる。
    ///
    /// 控えは `snapshot_note` を 11 回呼ばずに直に置く。11 回のあいだに
    /// 秒が変わると枝番が振り直され、並びの前提そのものが消える。
    #[test]
    fn eleven_snapshots_in_the_same_second_are_listed_newest_first() {
        let tmp = TempDir::new().unwrap();
        let filename = NoteFilename::parse("20260101_000000.md").unwrap();
        let dir = note_history_dir(tmp.path(), &filename);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("20260101_120000.md"), "x").unwrap();
        for n in 2..=11 {
            fs::write(dir.join(format!("20260101_120000-{n}.md")), "x").unwrap();
        }

        let ids: Vec<String> = list_note_history(tmp.path(), &filename)
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();

        assert_eq!(ids[0], "20260101_120000-11");
        assert_eq!(ids[1], "20260101_120000-10");
        assert_eq!(ids.last().unwrap(), "20260101_120000");
    }

    /// 控えの置き場は同期の走査範囲の外。載せると端末間で控えが往復する。
    #[test]
    fn history_lives_outside_the_synced_data_dir() {
        let tmp = TempDir::new().unwrap();
        let (_, filename) = note(tmp.path(), "body");

        snapshot_note(tmp.path(), &filename).unwrap();

        let synced = crate::sync::scan::scan_local_files(tmp.path()).unwrap();
        assert_eq!(synced.len(), 1, "only the note itself is scanned");
        assert!(tmp.path().join("history").is_dir());
    }

    #[test]
    fn an_id_that_is_not_a_timestamp_is_refused() {
        let tmp = TempDir::new().unwrap();
        let (_, filename) = note(tmp.path(), "body");

        for bad in [
            "../../etc/passwd",
            "20260101_000000-",
            "latest",
            "20260101_000000-x",
        ] {
            assert!(
                read_note_history(tmp.path(), &filename, bad).is_err(),
                "{bad} should be refused"
            );
        }
    }

    /// 戻したノートの frontmatter は控えの時点のもの。`updated` が戻すたびに
    /// 進んでいくと、「最後に書き直した時刻」が嘘になる。
    #[test]
    fn restoring_does_not_touch_the_frontmatter_it_restores() {
        let tmp = TempDir::new().unwrap();
        let (path, filename) = note(tmp.path(), "before");
        let snap = snapshot_note(tmp.path(), &filename).unwrap().unwrap();
        update_note(&path, "after", &Context::default(), None).unwrap();

        restore_note(tmp.path(), &filename, &snap.id).unwrap();

        let content = fs::read_to_string(&path).unwrap();
        let (fm, _) = frontmatter::parse::<NoteFrontmatter>(&content).unwrap();
        assert_eq!(fm.updated, None);
    }
}
