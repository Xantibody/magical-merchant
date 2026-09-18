use thiserror::Error;

#[derive(Debug, Error)]
pub enum ScrawlError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Parse error: {0}")]
    Parse(String),
}
