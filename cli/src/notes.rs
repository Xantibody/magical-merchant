//! MCP と CLI が共有するノートの書き込み経路。
//!
//! 外からの書き換えは本人が見ていないところで起きる。だから書く前に
//! 控えを取り(戻れる)、読んだときの revision を添えて(相手の編集を
//! 消さない)、frontmatter は core に任せる(規則を破らない)。どの入口から
//! 書いても同じ守りが効くよう、手順はここ 1 か所に置く。

use std::path::Path;

use chrono::{DateTime, FixedOffset};

use magical_merchant_core::utils::device::Context;
use magical_merchant_core::{CoreError, NoteFilename, Provenance, Revision, Snapshot};

/// 書き込み時に記録する端末。測り方はアプリと同じ core の probe で、
/// 電池もネットワークも OS の版もここで揃う。
///
/// 座標だけは載らない。測位は許可を取って数秒待つ仕事で、一行書いて
/// 終わる CLI にそれを待たせるのは高すぎる。アプリが最後に測った座標を
/// 使い回す手もあるが、アプリを開いていない日の記録に前の場所が付く。
/// 分からないことは分からないまま残す。
// AIDEV-NOTE: Wi-Fi から割り出す道も塞がり済み。SSID/BSSID は測位と同じ許可が要り、伏せられて返る
pub(crate) fn context() -> Context {
    magical_merchant_core::utils::device::probe()
}

/// 読んだ本文と、書き戻すときに添える revision。
#[derive(Debug)]
pub(crate) struct Read {
    pub(crate) body: String,
    pub(crate) revision: Revision,
}

#[derive(Debug)]
pub(crate) struct Written {
    /// 書き換える直前の全文の控え。
    pub(crate) snapshot: Snapshot,
    /// 書いた本文の revision。続けて書くときの `expected`。
    pub(crate) revision: Revision,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum WriteError {
    #[error("body is empty; delete is not offered here")]
    Empty,
    #[error("note not found: {0}")]
    NotFound(NoteFilename),
    /// 読んでから書くまでに、別の書き手(アプリ・MCP・CLI)が本文を変えた。
    #[error("{0} changed since it was read; re-read it and edit again")]
    Stale(NoteFilename),
    #[error("{0}")]
    Other(#[from] CoreError),
}

/// ノートを 1 本作る。返るのは付いたファイル名 — ノートの ID そのもの。
///
/// 空の本文では作らない(`None`)。打ち損ねやエディタを閉じただけの空が、
/// 消す手段の無い記録として残るのを避ける。出自は呼び出し側が名乗る:
/// 同じ経路を通る CLI と MCP を、共有のヘルパに一括で名乗らせない。
pub(crate) fn create(
    data_dir: &Path,
    body: &str,
    tags: &[String],
    provenance: Provenance<'_>,
) -> Result<Option<NoteFilename>, CoreError> {
    if body.trim().is_empty() {
        return Ok(None);
    }
    named(&magical_merchant_core::create_draft_note(
        data_dir,
        body,
        tags,
        &context(),
        provenance,
    )?)
}

/// 書かれた時刻を渡す版。外にあった記録は、その時刻がそのまま ID になる。
/// 空の本文を作らないのも、`context` を今この端末で書くのも `create` と同じ。
pub(crate) fn create_at(
    data_dir: &Path,
    time: DateTime<FixedOffset>,
    body: &str,
    tags: &[String],
    provenance: Provenance<'_>,
) -> Result<Option<NoteFilename>, CoreError> {
    if body.trim().is_empty() {
        return Ok(None);
    }
    named(&magical_merchant_core::create_note_at(
        data_dir,
        time,
        body,
        tags,
        &context(),
        provenance,
    )?)
}

/// 書いたファイルのパスを ID に読み替える。呼ぶ側が欲しいのは名前だけ。
fn named(path: &Path) -> Result<Option<NoteFilename>, CoreError> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| CoreError::NotFound(path.display().to_string()))?;
    NoteFilename::parse(name).map(Some)
}

pub(crate) fn read(data_dir: &Path, filename: &NoteFilename) -> Result<Read, CoreError> {
    let body = magical_merchant_core::read_note_by_filename(data_dir, filename)?;
    let revision = Revision::of(&body);
    Ok(Read { body, revision })
}

/// 本文を差し替える。控え → revision 照合 → 書き込み、の順は固定。
///
/// `expected` が `None` なら照合はしない。読まずに書く MCP クライアントの
/// ために残してあるが、読んだなら渡すのが筋。
pub(crate) fn overwrite(
    data_dir: &Path,
    filename: &NoteFilename,
    body: &str,
    expected: Option<&Revision>,
) -> Result<Written, WriteError> {
    if body.trim().is_empty() {
        return Err(WriteError::Empty);
    }
    // 控えを取る前にも照合する。core の照合だけだと、断られる書き込みの
    // ために相手の版の控えが 1 つ増える。core 側は最後の砦として残す
    if let Some(expected) = expected {
        let current = read(data_dir, filename)?;
        if current.revision != *expected {
            return Err(WriteError::Stale(filename.clone()));
        }
    }
    // 控えが取れなかった(存在しない)ノートには書かない。core も無い
    // ファイルは断るが、ここで先に見ると「見つからない」と名指しで言える
    let snapshot = magical_merchant_core::snapshot_note(data_dir, filename)?
        .ok_or_else(|| WriteError::NotFound(filename.clone()))?;
    // 置き場は core に聞く。Codex にしたノートは `notes/` には居ない
    let (_, path) = magical_merchant_core::locate_note(data_dir, filename)?;
    let revision = match magical_merchant_core::update_note(&path, body, &context(), expected) {
        Ok(revision) => revision,
        Err(CoreError::Stale(_)) => return Err(WriteError::Stale(filename.clone())),
        Err(e) => return Err(e.into()),
    };
    Ok(Written { snapshot, revision })
}

#[cfg(test)]
mod tests {
    use super::*;
    use magical_merchant_core::Provenance;
    use tempfile::TempDir;

    /// 端末について言えることは、アプリから書いても CLI から書いても同じ。
    /// 入り口の違いは `source` が語る担当で、`context` が痩せる理由にはならない。
    #[test]
    fn the_recorded_context_says_as_much_about_the_machine_as_the_app_does() {
        let context = context();
        let probed = magical_merchant_core::utils::device::probe();

        assert_eq!(context.os, std::env::consts::OS);
        assert_eq!(context.arch, std::env::consts::ARCH);
        assert_eq!(context.hostname, probed.hostname);
        assert_eq!(context.os_version, probed.os_version);
        assert_eq!(context.locale, probed.locale);
    }

    /// 座標だけは載せない。1 回で終わる CLI が測位を待つと、`-m` の一行を
    /// 書くたびに数秒止まる。古い座標で埋めるほうはもっと悪い
    /// (前に開いた場所が、いま書いた場所として残る)。
    #[test]
    fn the_recorded_context_carries_no_location() {
        assert!(context().location.is_none());
    }

    fn seed(base: &Path, body: &str) -> NoteFilename {
        let path = magical_merchant_core::create_draft_note(
            base,
            body,
            &[],
            &context(),
            Provenance::default(),
        )
        .unwrap();
        NoteFilename::parse(path.file_name().unwrap().to_str().unwrap()).unwrap()
    }

    fn body_of(base: &Path, filename: &NoteFilename) -> String {
        magical_merchant_core::read_note_by_filename(base, filename).unwrap()
    }

    /// Codex にしたノートも同じ ID で書ける。書く先は Codex の置き場で、
    /// `notes/` に同じ ID の普通のノートを作り直さない。
    #[test]
    fn overwriting_a_codex_writes_where_it_lives() {
        let tmp = TempDir::new().unwrap();
        let filename = seed(tmp.path(), "before");
        magical_merchant_core::promote_note_to_codex(tmp.path(), &filename).unwrap();

        overwrite(tmp.path(), &filename, "after", None).unwrap();

        assert_eq!(body_of(tmp.path(), &filename), "after");
        assert!(
            tmp.path()
                .join("data/codex")
                .join(filename.as_str())
                .exists()
        );
        assert!(
            !tmp.path()
                .join("data/notes")
                .join(filename.as_str())
                .exists()
        );
    }

    #[test]
    fn a_read_carries_the_revision_to_pass_back() {
        let tmp = TempDir::new().unwrap();
        let filename = seed(tmp.path(), "hello");

        let read = read(tmp.path(), &filename).unwrap();

        assert_eq!(read.body, "hello");
        assert_eq!(read.revision, Revision::of("hello"));
    }

    #[test]
    fn overwriting_with_the_read_revision_writes_and_leaves_a_copy() {
        let tmp = TempDir::new().unwrap();
        let filename = seed(tmp.path(), "before");
        let read = read(tmp.path(), &filename).unwrap();

        let written = overwrite(tmp.path(), &filename, "after", Some(&read.revision)).unwrap();

        assert_eq!(body_of(tmp.path(), &filename), "after");
        assert_eq!(written.revision, Revision::of("after"));
        let copy =
            magical_merchant_core::read_note_history(tmp.path(), &filename, &written.snapshot.id)
                .unwrap();
        assert!(copy.ends_with("before"));
    }

    #[test]
    fn overwriting_a_note_someone_else_changed_is_refused_and_keeps_theirs() {
        let tmp = TempDir::new().unwrap();
        let filename = seed(tmp.path(), "before");
        let read = read(tmp.path(), &filename).unwrap();
        overwrite(tmp.path(), &filename, "theirs", None).unwrap();

        let err = overwrite(tmp.path(), &filename, "mine", Some(&read.revision)).unwrap_err();

        assert!(matches!(err, WriteError::Stale(ref f) if *f == filename));
        assert_eq!(body_of(tmp.path(), &filename), "theirs");
        assert_eq!(
            magical_merchant_core::list_note_history(tmp.path(), &filename)
                .unwrap()
                .len(),
            1,
            "only the unguarded write left a copy; the refused one took none"
        );
    }

    #[test]
    fn an_empty_body_and_a_missing_note_are_refused_before_anything_is_written() {
        let tmp = TempDir::new().unwrap();
        let filename = seed(tmp.path(), "keep");
        let ghost = NoteFilename::parse("20260101_000000.md").unwrap();

        assert!(matches!(
            overwrite(tmp.path(), &filename, "  \n", None),
            Err(WriteError::Empty)
        ));
        assert!(matches!(
            overwrite(tmp.path(), &ghost, "ghost", None),
            Err(WriteError::NotFound(_))
        ));
        assert_eq!(body_of(tmp.path(), &filename), "keep");
        assert!(!tmp.path().join("data/notes/20260101_000000.md").exists());
        assert!(
            magical_merchant_core::list_note_history(tmp.path(), &filename)
                .unwrap()
                .is_empty(),
            "a refused write takes no copy"
        );
    }
}
