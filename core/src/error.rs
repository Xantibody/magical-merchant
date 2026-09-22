use thiserror::Error;

use crate::note::error::NoteError;
use crate::scrawl::error::ScrawlError;

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

    /// Another writer changed the body between the read and the write.
    #[error("Stale: {0} changed since it was read")]
    Stale(String),

    /// The file content cannot be read as text (invalid UTF-8). It is a byte sequence
    /// left behind by sync or an outside tool, and neither rewriting nor rereading fixes it.
    /// It is kept apart from [`Self::Io`] because it is not a failure that a later retry
    /// gets through: the caller treats it as a refusal and saves the typed text aside.
    /// It is also kept apart from [`Self::Parse`] (the record cannot be parsed): the remedy
    /// differs.
    #[error("Not text: {0} is not valid UTF-8")]
    NotText(String),

    /// Only a Codex can hold versions. Someone tried to commit one on a plain note.
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

impl From<ScrawlError> for CoreError {
    fn from(err: ScrawlError) -> Self {
        match err {
            ScrawlError::Io(e) => Self::Io(e),
            ScrawlError::Parse(s) => Self::Parse(s),
        }
    }
}
