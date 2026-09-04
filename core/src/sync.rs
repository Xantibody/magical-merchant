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
pub mod lock;
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
    pub errors: Vec<SyncIssue>,
}

/// 同期そのものは続いたが、1 つのキーだけこけたときの記録。
///
/// core は文章を組まない: 呼び手はアプリ (日本語にもなる UI)・CLI・MCP・
/// Android の JNI と分かれていて、翻訳表を置ける場所は core ではない。
/// 素材だけを返し、文にするのは表示する側 (アプリは `lib/i18n.ts` の
/// `sync.issue`)。`Display` は英語のままでよい CLI とログ用。
///
/// `kind` の文字列は TypeScript 側が分岐に使う識別子なので変えない。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SyncIssue {
    /// `..` や先頭の `/` を含むキー。手元にもサーバーにも渡さない
    UnsafeKey {
        key: String,
    },
    /// 走査には出たのに送る段になって見つからない
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
    /// 走査から削除までのあいだに書き換わったので、消さずに残した
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
    use super::{SyncError, SyncIssue};

    /// TypeScript 側は `kind` で分岐して文言を選ぶ。この形が変わると、
    /// 型は通ったまま画面の文言だけが消える
    #[test]
    fn an_issue_goes_over_the_wire_as_a_kind_and_its_parts() {
        let json = serde_json::to_value(SyncIssue::DeleteSkippedChanged {
            key: "notes/a.md".to_string(),
        })
        .unwrap();

        assert_eq!(json["kind"], "delete_skipped_changed");
        assert_eq!(json["key"], "notes/a.md");
    }

    /// CLI とログは英語のまま。翻訳するのはアプリだけ
    #[test]
    fn an_issue_still_prints_the_english_sentence() {
        let issue = SyncIssue::ReadFailed {
            key: "notes/a.md".to_string(),
            detail: "permission denied".to_string(),
        };

        assert_eq!(issue.to_string(), "read notes/a.md: permission denied");
    }

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
