use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProjectError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Already exists: {0}")]
    AlreadyExists(String),

    #[error("Invalid slug: {0}")]
    InvalidSlug(String),

    #[error("Parse error: {0}")]
    Parse(String),
}
