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
            NoteError::Io(e) => CoreError::Io(e),
            NoteError::NotFound(s) => CoreError::NotFound(s),
            NoteError::PathTraversal(s) => CoreError::PathTraversal(s),
            NoteError::Parse(s) => CoreError::Parse(s),
        }
    }
}

impl From<TimelineError> for CoreError {
    fn from(err: TimelineError) -> Self {
        match err {
            TimelineError::Io(e) => CoreError::Io(e),
            TimelineError::Parse(s) => CoreError::Parse(s),
        }
    }
}

impl From<ProjectError> for CoreError {
    fn from(err: ProjectError) -> Self {
        match err {
            ProjectError::Io(e) => CoreError::Io(e),
            ProjectError::NotFound(s) => CoreError::NotFound(s),
            ProjectError::AlreadyExists(s) => CoreError::AlreadyExists(s),
            ProjectError::InvalidSlug(s) => CoreError::InvalidSlug(s),
            ProjectError::Parse(s) => CoreError::Parse(s),
        }
    }
}
