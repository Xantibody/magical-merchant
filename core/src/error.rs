use thiserror::Error;

use crate::note::error::NoteError;
use crate::project::error::ProjectError;
use crate::timeline::error::TimelineError;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Invalid slug: {0}")]
    InvalidSlug(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Already exists: {0}")]
    AlreadyExists(String),

    #[error("Invalid path: {0}")]
    PathTraversal(String),

    #[error("Parse error: {0}")]
    Parse(String),

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

impl From<ProjectError> for CoreError {
    fn from(err: ProjectError) -> Self {
        match err {
            ProjectError::Io(e) => Self::Io(e),
            ProjectError::NotFound(s) => Self::NotFound(s),
            ProjectError::AlreadyExists(s) => Self::AlreadyExists(s),
            ProjectError::InvalidSlug(s) => Self::InvalidSlug(s),
            ProjectError::Parse(s) => Self::Parse(s),
        }
    }
}
