use thiserror::Error;

use crate::note::error::NoteError;
use crate::timeline::error::TimelineError;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Invalid path: {0}")]
    PathTraversal(String),

    #[error("Parse error: {0}")]
    Parse(String),

    /// 読んでから書くまでのあいだに、別の書き手が本文を変えていた。
    #[error("Stale: {0} changed since it was read")]
    Stale(String),

    /// ファイルの中身が文字として読めない(不正な UTF-8)。同期や外の道具が
    /// 置いていったバイト列で、書き直しても読み直しても直らない。
    /// [`Self::Io`] と分けるのは、あとで再試行すれば通る失敗ではないから —
    /// 呼ぶ側は拒否として扱い、打った字を退避させる。
    /// [`Self::Parse`](記録が読めない)とも分ける: 直す手当てが違う。
    #[error("Not text: {0} is not valid UTF-8")]
    NotText(String),

    /// 版を持てるのは Codex だけ。普通のノートに刻もうとした。
    #[error("Not a Codex: {0}")]
    NotCodex(String),

    #[error("Sync error: {0}")]
    Sync(String),

    #[error("Not authenticated")]
    NotAuthenticated,

    #[error("Network error: {0}")]
    Network(String),
}

impl From<NoteError> for CoreError {
    fn from(err: NoteError) -> Self {
        match err {
            NoteError::Io(e) => Self::Io(e),
            NoteError::NotFound(s) => Self::NotFound(s),
            NoteError::PathTraversal(s) => Self::PathTraversal(s),
            NoteError::Parse(s) => Self::Parse(s),
        }
    }
}

impl From<TimelineError> for CoreError {
    fn from(err: TimelineError) -> Self {
        match err {
            TimelineError::Io(e) => Self::Io(e),
            TimelineError::Parse(s) => Self::Parse(s),
        }
    }
}
