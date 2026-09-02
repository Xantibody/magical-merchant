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
