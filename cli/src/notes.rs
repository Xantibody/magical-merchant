//! MCP と CLI が共有するノートの書き込み経路。
//!
//! 外からの書き換えは本人が見ていないところで起きる。だから書く前に
//! 控えを取り(戻れる)、読んだときの revision を添えて(相手の編集を
//! 消さない)、frontmatter は core に任せる(規則を破らない)。どの入口から
//! 書いても同じ守りが効くよう、手順はここ 1 か所に置く。

use std::path::Path;

use magical_merchant_core::utils::device::Context;
use magical_merchant_core::{CoreError, NoteFilename, Revision, Snapshot};

/// 書き込み時に記録する端末。座標や電池は端末の外から読めないので、
/// 分かる範囲(OS と CPU)だけを正直に書く。
pub(crate) fn context() -> Context {
    Context {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        ..Context::default()
    }
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
    // 控えが取れなかった(存在しない)ノートには書かない。update は
    // 無いファイルを frontmatter ごとでっち上げてしまう
    let snapshot = magical_merchant_core::snapshot_note(data_dir, filename)?
        .ok_or_else(|| WriteError::NotFound(filename.clone()))?;
    let path = magical_merchant_core::utils::paths::notes_dir(data_dir).join(filename.as_str());
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
    use tempfile::TempDir;

    fn seed(base: &Path, body: &str) -> NoteFilename {
        let path = magical_merchant_core::create_draft_note(base, body, &[], &context()).unwrap();
        NoteFilename::parse(path.file_name().unwrap().to_str().unwrap()).unwrap()
    }

    fn body_of(base: &Path, filename: &NoteFilename) -> String {
        magical_merchant_core::read_note_by_filename(base, filename).unwrap()
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
