//! Workers/R2 同期 API の wire 型と HTTP クライアント。
//!
//! `reqwest::Client` は組み立てずに受け取る。Android だけは端末の検証器を迂回した
//! TLS 設定で組む必要があり(`android_tls::sync_tls_config`)、その判断は
//! プラットフォームを知っているアプリ側にしか置けない。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::SyncError;

// ──────────── HTTP wire types ────────────

/// 同期状態はサーバーが持つ。クライアントは受け取った状態をそのまま保存するだけで、
/// 自分で組み立てて送り返さない（送り返すと、まだ手元に無いファイルが状態から
/// 抜け落ち、次の同期で全端末がそれを「削除された」と解釈してしまう）
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ServerSyncState {
    pub(crate) files: HashMap<String, ServerFileRecord>,
    #[allow(dead_code)]
    pub(crate) last_sync: Option<String>,
    /// bulk レスポンスの `new_state` には付かない
    #[serde(default)]
    pub(crate) etag: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ServerFileRecord {
    pub(crate) hash: String,
    pub(crate) last_modified: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct WireUpload {
    pub(crate) key: String,
    pub(crate) content_base64: String,
    pub(crate) last_modified: String,
    pub(crate) hash: String,
}

/// 競合は常にローカル優先。上書きされるリモート側は `conflict_key` に退避され、
/// レスポンスでも返ってくるのでローカルにも競合コピーとして残す
#[derive(Debug, Serialize)]
pub(crate) struct WireConflictOp {
    pub(crate) key: String,
    pub(crate) conflict_key: String,
    pub(crate) content_base64: String,
    pub(crate) hash: String,
    pub(crate) last_modified: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct BulkRequest {
    pub(crate) uploads: Vec<WireUpload>,
    pub(crate) downloads: Vec<String>,
    pub(crate) delete_remote: Vec<String>,
    pub(crate) conflicts: Vec<WireConflictOp>,
    pub(crate) expected_etag: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct BulkResponse {
    pub(crate) downloads: Vec<DownloadedFile>,
    pub(crate) conflict_downloads: Vec<DownloadedFile>,
    pub(crate) new_state: ServerSyncState,
}

#[derive(Debug, Deserialize)]
pub(crate) struct DownloadedFile {
    pub(crate) key: String,
    pub(crate) content_base64: String,
}

// ──────────── HTTP client ────────────

#[derive(Debug)]
pub struct HttpClient {
    http: reqwest::Client,
    base_url: String,
    token: String,
}

impl HttpClient {
    #[must_use]
    pub fn new(http: reqwest::Client, base_url: &str, token: &str) -> Self {
        Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
            token: token.to_string(),
        }
    }

    fn auth(&self) -> String {
        format!("Bearer {}", self.token)
    }

    pub(crate) async fn get_sync_state(&self) -> Result<ServerSyncState, SyncError> {
        let resp = self
            .http
            .get(format!("{}/sync-state", self.base_url))
            .header("Authorization", self.auth())
            .send()
            .await
            .map_err(|e| network_error(&e))?;

        let resp = check_status(resp, "get_sync_state").await?;

        resp.json()
            .await
            .map_err(|e| SyncError::other(format!("Failed to parse sync state: {e}")))
    }

    pub(crate) async fn bulk(&self, req: BulkRequest) -> Result<BulkResponse, SyncError> {
        let resp = self
            .http
            .post(format!("{}/sync/bulk", self.base_url))
            .header("Authorization", self.auth())
            .json(&req)
            .send()
            .await
            .map_err(|e| network_error(&e))?;

        if resp.status() == reqwest::StatusCode::CONFLICT {
            return Err(SyncError::new(
                "conflict",
                "Sync state changed concurrently, please retry",
            ));
        }

        let resp = check_status(resp, "bulk").await?;

        resp.json()
            .await
            .map_err(|e| SyncError::other(format!("Failed to parse bulk response: {e}")))
    }
}

/// reqwest 0.12 以降の `Display` は「error sending request for url (…)」で
/// 止まり、DNS・TCP・TLS のどこで落ちたかは `source()` を辿らないと出てこない。
/// Android の TLS 検証は Java 経由で、ログも無いので、この連鎖が唯一の手がかり。
fn network_error(e: &reqwest::Error) -> SyncError {
    SyncError::new("network", format!("Network error: {}", describe(e)))
}

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

/// 非成功ステータスを kind 付きエラーに変換する。
/// これを怠ると失敗したアップロードを成功扱いで同期状態に記録したり、
/// エラーレスポンスのボディをノート本文としてローカルに書き込んだりしてしまう。
async fn check_status(
    resp: reqwest::Response,
    context: &str,
) -> Result<reqwest::Response, SyncError> {
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(SyncError::new(
            "notAuthenticated",
            "The server rejected the login. Log in again from Settings.",
        ));
    }
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(SyncError::other(format!(
            "{context} failed ({status}): {text}"
        )));
    }
    Ok(resp)
}

#[cfg(test)]
mod tests {
    use super::describe;

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
