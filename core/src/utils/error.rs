// AIDEV-NOTE: kept in utils though it names app errors; services and domain both return it, and services may not import domain.

use serde::Serialize;
use thiserror::Error;

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

impl CoreError {
    /// The OS message alone for [`Self::Io`], without the `IO error: ` that `Display` puts
    /// in front; any other kind as `Display` writes it. For words a caller already showed
    /// with a bare `std::io::Error` before its disk access went through `services::files`.
    #[must_use]
    pub fn plain_message(&self) -> String {
        match self {
            Self::Io(e) => e.to_string(),
            other => other.to_string(),
        }
    }
}

/// Returns the error with a kind, so the frontend can choose between "go to settings",
/// "retry" and the like.
///
/// The `kind` strings are identifiers the TypeScript side branches on, so do not change them.
#[derive(Debug, Clone, Serialize)]
pub struct SyncError {
    pub kind: &'static str,
    pub message: String,
}

impl SyncError {
    #[must_use]
    pub fn new<M: Into<String>>(kind: &'static str, message: M) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    /// For internal errors that fit no category. The UI falls back to the generic error display
    #[must_use]
    pub fn other<M: Into<String>>(message: M) -> Self {
        Self::new("other", message)
    }
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SyncError {}

#[must_use]
pub fn describe(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut cur = e.source();
    while let Some(s) = cur {
        out.push_str(": ");
        out.push_str(&s.to_string());
        cur = s.source();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{CoreError, SyncError, describe};

    #[test]
    fn a_plain_message_drops_only_the_io_prefix() {
        let io = CoreError::Io(std::io::Error::other("permission denied"));
        let parse = CoreError::Parse("bad".to_string());

        assert_eq!(io.plain_message(), "permission denied");
        assert_eq!(parse.plain_message(), "Parse error: bad");
    }

    #[test]
    fn other_errors_keep_message() {
        let info = SyncError::other("boom");
        assert_eq!(info.kind, "other");
        assert!(info.message.contains("boom"));
    }

    #[test]
    fn describe_walks_the_source_chain() {
        #[derive(Debug)]
        struct Outer(std::io::Error);
        impl std::fmt::Display for Outer {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("error sending request")
            }
        }
        impl std::error::Error for Outer {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&self.0)
            }
        }
        let inner = std::io::Error::other("invalid peer certificate: UnknownIssuer");
        assert_eq!(
            describe(&Outer(inner)),
            "error sending request: invalid peer certificate: UnknownIssuer"
        );
    }
}
