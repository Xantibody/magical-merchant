//! Codex の版 — 人が「ここまで」と刻んだ本文の全文。
//!
//! `history.rs` の控えとは別物。控えは外部からの上書きの前に機械が取る退避で、
//! 端末の中だけ・直近 20 件。版は人が message を添えて刻む記録で、どの端末で
//! 開いても同じ履歴が見えなければ「蓄積」にならないので `data/` の中に置き、
//! 同期に載せる。
//!
//! 1 版 = 本文の全文 + 小さな frontmatter(`time` / `message`)の Markdown 1 つ。
//! 差分の鎖で持たないのは、同期がキー単位で独立していて順序も欠落も保証しない
//! から — 全文なら届いた版はそれだけで読めて戻せる。diff は読むときに計算する。
//! git も 1 版を全文で持っている。差分が取りやすいのは保存形式ではなく、
//! 比べたい 2 つの全文がすぐ手に入ることによる。
//!
//! 版 ID は `YYYYMMDD_HHMMSS-<本文 SHA-256 の先頭 8 hex>`。時刻だけでは 2 端末が
//! 同じ秒に刻むとぶつかる。内容のハッシュを添えると、ぶつかるのは「同じ秒に
//! 同じ本文」のときだけで、それは同じ版なので 1 つに畳まれて正しい。
//!
//! `PoC` の段階では、版の置き場だけ `data/codex/<stem>/` に置き、ノート本体は
//! まだ `data/notes/` から読む。Codex 用ディレクトリへの移動は別バッチ。

use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, FixedOffset, Local, NaiveDateTime};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use similar::{Algorithm, TextDiff};

use crate::error::CoreError;
use crate::note::Revision;
use crate::note::kind::NoteKind;
use crate::note::repository::Notes;
use crate::utils::device::Context;
use crate::utils::frontmatter;
use crate::utils::fs::{ensure_dir, list_md_files, write_atomic};
use crate::utils::paths::codex_dir;
use crate::utils::validated::NoteFilename;

/// diff のヘッダで「いまの下書き」を指す名前。版 ID の形(数字と `-` と hex)
/// とは重ならないので、読む側が版と見間違えない。
pub const DRAFT: &str = "draft";

/// 戻す直前に刻む版の message。ファイルに書く記録なので言語で変えず、表示側が
/// この文字列を知っていれば訳して出せる。
pub const BEFORE_RESTORE: &str = "before restore";

/// 版 1 つ。`id` がそのまま `read` / `diff` / `restore` の引数。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Version {
    pub id: String,
    /// 刻んだ時刻。frontmatter から読む — 同期で降ってきた版の mtime は届いた
    /// 時刻でしかない。
    pub time: DateTime<FixedOffset>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// 本文のバイト数。一覧で前の版との増減を出すため。
    pub bytes: u64,
}

/// 開いている 1 本の「版 N · 最後の版から変更あり」。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct VersionStatus {
    pub count: usize,
    /// 最新の版と下書きの本文が違うか。版が無ければ false。
    pub dirty: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct VersionFrontmatter {
    time: DateTime<FixedOffset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

pub(crate) fn versions_dir(base_dir: &Path, filename: &NoteFilename) -> PathBuf {
    codex_dir(base_dir).join(filename.as_str().trim_end_matches(".md"))
}

fn short_hash(body: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(body.as_bytes());
    let mut hex = String::with_capacity(8);
    for byte in &digest[..4] {
        hex.push(char::from(HEX[usize::from(byte >> 4)]));
        hex.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    hex
}

fn version_id(time: DateTime<FixedOffset>, body: &str) -> String {
    format!("{}-{}", time.format("%Y%m%d_%H%M%S"), short_hash(body))
}

/// 版の名前として通るのは日時と 8 桁の hex だけ。`..` や `/` を含む id で
/// 版の置き場の外を読み書きさせない。
fn version_path(dir: &Path, id: &str) -> Result<PathBuf, CoreError> {
    let well_formed = id.split_once('-').is_some_and(|(stamp, hash)| {
        NaiveDateTime::parse_from_str(stamp, "%Y%m%d_%H%M%S").is_ok()
            && hash.len() == 8
            && hash.bytes().all(|b| b.is_ascii_hexdigit())
    });
    if !well_formed {
        return Err(CoreError::PathTraversal(id.to_string()));
    }
    Ok(dir.join(format!("{id}.md")))
}

/// 版を持てるのは Codex だけ。普通のノートの本文を返してしまうと、
/// `data/codex/<stem>/` に本体の無い版が生まれ、同期で配られ続ける。
fn read_body(base_dir: &Path, filename: &NoteFilename) -> Result<String, CoreError> {
    let notes = Notes::new(base_dir.to_path_buf());
    let (kind, _) = notes.locate(filename)?;
    if kind != NoteKind::Codex {
        return Err(CoreError::NotCodex(filename.as_str().to_string()));
    }
    notes.read(filename)
}

fn read_version_file(path: &Path) -> Result<(VersionFrontmatter, String), CoreError> {
    let content = fs::read_to_string(path)?;
    let (fm, body) = frontmatter::parse::<VersionFrontmatter>(&content)?;
    Ok((fm, body.to_string()))
}

/// いまの本文を版として刻む。同じ秒に同じ本文の版がすでにあれば、それを
/// 書き直さずに返す(同じ版なので)。
pub fn commit_note_version(
    base_dir: &Path,
    filename: &NoteFilename,
    message: Option<&str>,
) -> Result<Version, CoreError> {
    let body = read_body(base_dir, filename)?;
    let now = Local::now().fixed_offset();
    let id = version_id(now, &body);
    let dir = versions_dir(base_dir, filename);
    let path = version_path(&dir, &id)?;
    if path.exists() {
        let (fm, body) = read_version_file(&path)?;
        return Ok(Version {
            id,
            time: fm.time,
            message: fm.message,
            bytes: body.len() as u64,
        });
    }
    let fm = VersionFrontmatter {
        time: now,
        message: message.map(str::to_string),
    };
    ensure_dir(&path)?;
    write_atomic(&path, frontmatter::render(&fm, &body)?)?;
    Ok(Version {
        id,
        time: now,
        message: fm.message,
        bytes: body.len() as u64,
    })
}

/// 版を新しい順に。読めない版(壊れた frontmatter)は一覧から落とすだけで、
/// 他の版は読める。
pub fn list_note_versions(
    base_dir: &Path,
    filename: &NoteFilename,
) -> Result<Vec<Version>, CoreError> {
    let dir = versions_dir(base_dir, filename);
    let mut versions: Vec<Version> = list_md_files(&dir)?
        .into_iter()
        .filter_map(|entry| {
            let name = entry.file_name();
            let id = Path::new(&name).file_stem()?.to_str()?.to_string();
            let (fm, body) = read_version_file(&entry.path()).ok()?;
            Some(Version {
                id,
                time: fm.time,
                message: fm.message,
                bytes: body.len() as u64,
            })
        })
        .collect();
    // 同じ秒の版は id(hex)で決定的に並べる。時刻は端末ごとのオフセット付きで
    // 書かれているので、比べるのは瞬間であって壁時計ではない
    versions.sort_by(|a, b| b.time.cmp(&a.time).then_with(|| b.id.cmp(&a.id)));
    Ok(versions)
}

/// 版の本文。frontmatter は付けない — `read_note` と同じく、読む側に見せる
/// ものではない。
pub fn read_note_version(
    base_dir: &Path,
    filename: &NoteFilename,
    id: &str,
) -> Result<String, CoreError> {
    let path = version_path(&versions_dir(base_dir, filename), id)?;
    if !path.exists() {
        return Err(CoreError::NotFound(path.to_string_lossy().to_string()));
    }
    Ok(read_version_file(&path)?.1)
}

/// `from` の版から `to` への unified diff。`to` が `None` なら下書き(いまの
/// 本文)。同じなら空文字列で、ヘッダも出さない。
pub fn diff_note_versions(
    base_dir: &Path,
    filename: &NoteFilename,
    from: &str,
    to: Option<&str>,
) -> Result<String, CoreError> {
    let old = read_note_version(base_dir, filename, from)?;
    let new = match to {
        Some(id) => read_note_version(base_dir, filename, id)?,
        None => read_body(base_dir, filename)?,
    };
    Ok(unified_diff(&old, &new, from, to.unwrap_or(DRAFT)))
}

/// 3.x の Histogram は大きい入力で極端に遅い(10 万行で秒単位)。Myers は
/// ノートの大きさでは十分速く、無関係な 2 文でも線形時間の経路がある。
fn unified_diff(old: &str, new: &str, old_name: &str, new_name: &str) -> String {
    if old == new {
        return String::new();
    }
    TextDiff::configure()
        .algorithm(Algorithm::Myers)
        .diff_lines(old, new)
        .unified_diff()
        .context_radius(3)
        .header(old_name, new_name)
        .to_string()
}

/// 版の本文を下書きにする。先にいまの下書きを [`BEFORE_RESTORE`] の版として
/// 刻むので、戻したこと自体も戻せる。書き込みは `update_note` と同じ経路 —
/// `expected` が古ければ [`CoreError::Stale`] で何も書かない(刻みもしない)。
pub fn restore_note_version(
    base_dir: &Path,
    filename: &NoteFilename,
    id: &str,
    context: &Context,
    expected: Option<&Revision>,
) -> Result<Revision, CoreError> {
    let restored = read_note_version(base_dir, filename, id)?;
    let (_, path) = Notes::new(base_dir.to_path_buf()).locate(filename)?;
    if let Some(expected) = expected {
        let current = Revision::of(&read_body(base_dir, filename)?);
        if current != *expected {
            return Err(CoreError::Stale(filename.as_str().to_string()));
        }
    }
    commit_note_version(base_dir, filename, Some(BEFORE_RESTORE))?;
    Notes::update(&path, &restored, context, expected)
}

/// 版の数と、最新の版から下書きが変わっているか。
pub fn note_version_status(
    base_dir: &Path,
    filename: &NoteFilename,
) -> Result<VersionStatus, CoreError> {
    // 版が無くても本文は読む — 普通のノートには `NotCodex` で答える
    let body = read_body(base_dir, filename)?;
    let versions = list_note_versions(base_dir, filename)?;
    let dirty = match versions.first() {
        Some(latest) => read_note_version(base_dir, filename, &latest.id)? != body,
        None => false,
    };
    Ok(VersionStatus {
        count: versions.len(),
        dirty,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::frontmatter::Provenance;
    use crate::{create_draft_codex, create_draft_note, read_note_by_filename, update_note};
    use chrono::TimeZone;
    use tempfile::TempDir;

    /// 版を刻む相手。Codex でなければ刻めないので、テストの既定は Codex。
    fn note(base: &Path, body: &str) -> (PathBuf, NoteFilename) {
        let path = create_draft_codex(base, body, &[], &Context::default(), Provenance::default())
            .unwrap();
        let filename = NoteFilename::parse(path.file_name().unwrap().to_str().unwrap()).unwrap();
        (path, filename)
    }

    /// 普通のノートには刻めない。断るだけで、版のディレクトリも作らない。
    #[test]
    fn a_plain_note_cannot_be_given_versions() {
        let tmp = TempDir::new().unwrap();
        let path = create_draft_note(
            tmp.path(),
            "ただのノート",
            &[],
            &Context::default(),
            Provenance::default(),
        )
        .unwrap();
        let filename = NoteFilename::parse(path.file_name().unwrap().to_str().unwrap()).unwrap();

        let result = commit_note_version(tmp.path(), &filename, Some("試し"));

        assert!(matches!(result, Err(CoreError::NotCodex(_))));
        assert!(!versions_dir(tmp.path(), &filename).exists());
        assert!(matches!(
            note_version_status(tmp.path(), &filename),
            Err(CoreError::NotCodex(_))
        ));
    }

    #[test]
    fn a_note_without_versions_has_none() {
        let tmp = TempDir::new().unwrap();
        let (_, filename) = note(tmp.path(), "body");

        assert!(
            list_note_versions(tmp.path(), &filename)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            note_version_status(tmp.path(), &filename).unwrap(),
            VersionStatus {
                count: 0,
                dirty: false
            }
        );
    }

    #[test]
    fn the_first_version_keeps_the_body_the_message_and_the_time() {
        let tmp = TempDir::new().unwrap();
        let (_, filename) = note(tmp.path(), "# 題\n\n本文");

        let version = commit_note_version(tmp.path(), &filename, Some("最初の版")).unwrap();

        let listed = list_note_versions(tmp.path(), &filename).unwrap();
        assert_eq!(listed, vec![version.clone()]);
        assert_eq!(version.message.as_deref(), Some("最初の版"));
        assert_eq!(version.bytes, "# 題\n\n本文".len() as u64);
        let body = read_note_version(tmp.path(), &filename, &version.id).unwrap();
        assert_eq!(body, "# 題\n\n本文", "frontmatter は付いてこない");
        assert_eq!(
            note_version_status(tmp.path(), &filename).unwrap(),
            VersionStatus {
                count: 1,
                dirty: false
            }
        );
    }

    /// 版は `data/` の中、その Codex の stem の下。同期の走査に載る。
    #[test]
    fn a_version_is_a_markdown_file_under_the_synced_codex_tree() {
        let tmp = TempDir::new().unwrap();
        let (_, filename) = note(tmp.path(), "body");

        let version = commit_note_version(tmp.path(), &filename, None).unwrap();

        let stem = filename.as_str().trim_end_matches(".md");
        let path = tmp
            .path()
            .join("data")
            .join("codex")
            .join(stem)
            .join(format!("{}.md", version.id));
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.starts_with("---\ntime: "), "{content}");
        assert!(content.ends_with("---\nbody"), "{content}");
        assert!(!content.contains("message"), "無い message は書かない");

        let keys: Vec<String> = crate::sync::scan::scan_local_files(tmp.path())
            .unwrap()
            .into_iter()
            .map(|f| f.key)
            .collect();
        assert!(
            keys.contains(&format!("codex/{stem}/{}.md", version.id)),
            "{keys:?}"
        );
    }

    #[test]
    fn the_same_body_in_the_same_second_is_the_same_version() {
        let tmp = TempDir::new().unwrap();
        let (_, filename) = note(tmp.path(), "body");

        let first = commit_note_version(tmp.path(), &filename, Some("a")).unwrap();
        let again = commit_note_version(tmp.path(), &filename, Some("b")).unwrap();

        assert_eq!(first, again, "書き直さないので message も最初のまま");
        assert_eq!(list_note_versions(tmp.path(), &filename).unwrap().len(), 1);
    }

    /// 同じ本文でも秒が違えば別の版、同じ秒でも本文が違えば別の版。
    #[test]
    fn the_id_is_the_second_and_the_body_together() {
        let t1 = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 9, 17, 14, 3, 0)
            .unwrap();
        let t2 = t1 + chrono::Duration::seconds(1);

        assert_ne!(version_id(t1, "a"), version_id(t2, "a"));
        assert_ne!(version_id(t1, "a"), version_id(t1, "b"));
        assert_eq!(version_id(t1, "a"), version_id(t1, "a"));
        assert!(version_id(t1, "a").starts_with("20260917_140300-"));
    }

    #[test]
    fn a_changed_body_makes_a_second_version_listed_newest_first() {
        let tmp = TempDir::new().unwrap();
        let (path, filename) = note(tmp.path(), "one");
        let first = commit_note_version(tmp.path(), &filename, None).unwrap();
        update_note(&path, "two", &Context::default(), None).unwrap();

        let second = commit_note_version(tmp.path(), &filename, None).unwrap();

        let ids: Vec<String> = list_note_versions(tmp.path(), &filename)
            .unwrap()
            .into_iter()
            .map(|v| v.id)
            .collect();
        assert_eq!(ids, vec![second.id, first.id.clone()]);
        assert_eq!(
            read_note_version(tmp.path(), &filename, &first.id).unwrap(),
            "one"
        );
    }

    #[test]
    fn diff_against_the_draft_is_a_unified_diff_and_empty_when_equal() {
        let tmp = TempDir::new().unwrap();
        let (path, filename) = note(tmp.path(), "a\nb\nc\n");
        let version = commit_note_version(tmp.path(), &filename, None).unwrap();

        assert_eq!(
            diff_note_versions(tmp.path(), &filename, &version.id, None).unwrap(),
            "",
            "同じならヘッダも出さない"
        );

        update_note(&path, "a\nB\nc\nd\n", &Context::default(), None).unwrap();
        let diff = diff_note_versions(tmp.path(), &filename, &version.id, None).unwrap();

        assert_eq!(
            diff,
            format!(
                "--- {}\n+++ draft\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+d\n",
                version.id
            )
        );
    }

    #[test]
    fn diff_between_two_versions_names_both() {
        let tmp = TempDir::new().unwrap();
        let (path, filename) = note(tmp.path(), "x\n");
        let old = commit_note_version(tmp.path(), &filename, None).unwrap();
        update_note(&path, "y\n", &Context::default(), None).unwrap();
        let new = commit_note_version(tmp.path(), &filename, None).unwrap();

        let diff = diff_note_versions(tmp.path(), &filename, &old.id, Some(&new.id)).unwrap();

        assert!(
            diff.starts_with(&format!("--- {}\n+++ {}\n", old.id, new.id)),
            "{diff}"
        );
        assert!(diff.contains("-x\n+y\n"), "{diff}");
    }

    #[test]
    fn restoring_brings_the_version_back_and_keeps_the_draft_as_a_version() {
        let tmp = TempDir::new().unwrap();
        let (path, filename) = note(tmp.path(), "before");
        let version = commit_note_version(tmp.path(), &filename, None).unwrap();
        update_note(&path, "after", &Context::default(), None).unwrap();
        let read = Revision::of("after");

        let revision = restore_note_version(
            tmp.path(),
            &filename,
            &version.id,
            &Context::default(),
            Some(&read),
        )
        .unwrap();

        assert_eq!(revision, Revision::of("before"));
        assert_eq!(
            read_note_by_filename(tmp.path(), &filename).unwrap(),
            "before"
        );
        let listed = list_note_versions(tmp.path(), &filename).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].message.as_deref(), Some(BEFORE_RESTORE));
        assert_eq!(
            read_note_version(tmp.path(), &filename, &listed[0].id).unwrap(),
            "after"
        );
    }

    #[test]
    fn a_stale_restore_writes_nothing_and_commits_nothing() {
        let tmp = TempDir::new().unwrap();
        let (path, filename) = note(tmp.path(), "before");
        let version = commit_note_version(tmp.path(), &filename, None).unwrap();
        update_note(&path, "after", &Context::default(), None).unwrap();
        let stale = Revision::of("something else");

        let err = restore_note_version(
            tmp.path(),
            &filename,
            &version.id,
            &Context::default(),
            Some(&stale),
        )
        .unwrap_err();

        assert!(matches!(err, CoreError::Stale(_)), "{err}");
        assert_eq!(
            read_note_by_filename(tmp.path(), &filename).unwrap(),
            "after"
        );
        assert_eq!(list_note_versions(tmp.path(), &filename).unwrap().len(), 1);
    }

    #[test]
    fn editing_after_a_version_makes_the_draft_dirty() {
        let tmp = TempDir::new().unwrap();
        let (path, filename) = note(tmp.path(), "one");
        commit_note_version(tmp.path(), &filename, None).unwrap();
        update_note(&path, "two", &Context::default(), None).unwrap();

        assert_eq!(
            note_version_status(tmp.path(), &filename).unwrap(),
            VersionStatus {
                count: 1,
                dirty: true
            }
        );
    }

    #[test]
    fn an_id_that_is_not_a_version_name_cannot_leave_the_directory() {
        let tmp = TempDir::new().unwrap();
        let (_, filename) = note(tmp.path(), "body");

        for id in [
            "../../etc/passwd",
            "20260917_140300",
            "20260917_140300-zz",
            "",
        ] {
            let err = read_note_version(tmp.path(), &filename, id).unwrap_err();
            assert!(matches!(err, CoreError::PathTraversal(_)), "{id}: {err}");
        }
        let err = read_note_version(tmp.path(), &filename, "20260917_140300-0123abcd").unwrap_err();
        assert!(matches!(err, CoreError::NotFound(_)), "{err}");
    }
}
