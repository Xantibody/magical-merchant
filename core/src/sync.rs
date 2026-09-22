use serde::Serialize;

pub mod conflict;
pub mod diff;
pub mod scan;
pub mod state;

// Only the parts that speak HTTP sit behind the feature. The Android JNI build and the
// MCP-only CLI need neither reqwest nor keyring, so the default does not pull them in.
#[cfg(feature = "sync-client")]
pub mod client;
#[cfg(feature = "sync-client")]
pub mod config;
#[cfg(feature = "sync-client")]
pub mod engine;
#[cfg(feature = "sync-client")]
pub mod lock;
#[cfg(feature = "sync-client")]
pub mod round;
#[cfg(feature = "sync-client")]
pub mod token;

/// The breakdown of what happened in one sync.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SyncResult {
    pub uploaded: usize,
    pub downloaded: usize,
    pub deleted_remote: usize,
    pub deleted_local: usize,
    pub conflicts: usize,
    pub errors: Vec<SyncIssue>,
}

/// A record of one key that failed while the sync itself went on.
///
/// core composes no sentences: the callers are split across the app (a UI that can be
/// Japanese), the CLI, MCP and the Android JNI, and core is not the place for a
/// translation table. It returns only the parts; the side that displays them builds the
/// sentence (the app in `sync.result.issue` of `lib/i18n.ts`). `Display` serves the CLI and the
/// logs, where English is fine.
///
/// The `kind` strings are identifiers the TypeScript side branches on, so do not change them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SyncIssue {
    /// A key that contains `..` or a leading `/`. It goes neither to disk nor to the server
    UnsafeKey {
        key: String,
    },
    /// An upload or conflict names a key the scan did not list (a file gone by the time
    /// it is read is `ReadFailed`)
    MissingLocalFile {
        key: String,
    },
    ReadFailed {
        key: String,
        detail: String,
    },
    WriteFailed {
        key: String,
        detail: String,
    },
    DecodeFailed {
        key: String,
        detail: String,
    },
    DeleteFailed {
        key: String,
        detail: String,
    },
    /// It changed between the scan and the delete, so it was kept instead of deleted
    DeleteSkippedChanged {
        key: String,
    },
}

impl std::fmt::Display for SyncIssue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsafeKey { key } => write!(f, "unsafe key rejected: {key}"),
            Self::MissingLocalFile { key } => write!(f, "missing local file: {key}"),
            Self::ReadFailed { key, detail } => write!(f, "read {key}: {detail}"),
            Self::WriteFailed { key, detail } => write!(f, "write {key}: {detail}"),
            Self::DecodeFailed { key, detail } => write!(f, "base64 decode {key}: {detail}"),
            Self::DeleteFailed { key, detail } => write!(f, "delete_local {key}: {detail}"),
            Self::DeleteSkippedChanged { key } => {
                write!(f, "delete_local {key}: changed since scan, kept")
            }
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

#[cfg(test)]
mod tests {
    use super::{SyncError, SyncIssue};

    /// The TypeScript side branches on `kind` to pick the wording. If this shape changes,
    /// the types still pass and only the wording on screen disappears
    #[test]
    fn an_issue_goes_over_the_wire_as_a_kind_and_its_parts() {
        let json = serde_json::to_value(SyncIssue::DeleteSkippedChanged {
            key: "notes/a.md".to_string(),
        })
        .unwrap();

        assert_eq!(json["kind"], "delete_skipped_changed");
        assert_eq!(json["key"], "notes/a.md");
    }

    /// The CLI and the logs stay English. Only the app translates
    #[test]
    fn an_issue_still_prints_the_english_sentence() {
        let issue = SyncIssue::ReadFailed {
            key: "notes/a.md".to_string(),
            detail: "permission denied".to_string(),
        };

        assert_eq!(issue.to_string(), "read notes/a.md: permission denied");
    }

    #[test]
    fn other_errors_keep_message() {
        let info = SyncError::other("boom");
        assert_eq!(info.kind, "other");
        assert!(info.message.contains("boom"));
    }
}
