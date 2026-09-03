use serde::Serialize;

pub mod conflict;
pub mod diff;
pub mod scan;
pub mod state;

// HTTP を話す部分だけ feature の裏。Android の JNI ビルドと MCP-only の CLI は
// reqwest も keyring も要らないので、既定では引き込まない。
#[cfg(feature = "sync-client")]
pub mod client;
#[cfg(feature = "sync-client")]
pub mod config;
#[cfg(feature = "sync-client")]
pub mod engine;
#[cfg(feature = "sync-client")]
pub mod token;

/// 1 回の同期でおきたことの内訳。
#[derive(Debug, Clone, Default, Serialize)]
pub struct SyncResult {
    pub uploaded: usize,
    pub downloaded: usize,
    pub deleted_remote: usize,
    pub deleted_local: usize,
    pub conflicts: usize,
    pub errors: Vec<String>,
}

/// フロントが「設定へ誘導」「再試行」などを出し分けられるよう、
/// エラーを kind 付きで返す。
///
/// `kind` の文字列は TypeScript 側が分岐に使っている識別子なので変えない。
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

    /// 分類できない内部エラー用。UI は汎用のエラー表示にフォールバックする
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
    use super::SyncError;

    #[test]
    fn busy_error_is_tagged_so_ui_can_ignore_it() {
        let info = SyncError::new("busy", "Sync already in progress");
        assert_eq!(info.kind, "busy");
    }

    #[test]
    fn other_errors_keep_message() {
        let info = SyncError::other("boom");
        assert_eq!(info.kind, "other");
        assert!(info.message.contains("boom"));
    }
}
