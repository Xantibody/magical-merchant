//! Wire types and HTTP client for the Workers/R2 sync API.
//!
//! The `reqwest::Client` is received, not built here. Android alone has to build it with a
//! TLS config that bypasses the device's verifier (`android_tls::sync_tls_config`), and
//! that decision can only live on the app side, which knows the platform.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::SyncError;

// ──────────── HTTP wire types ────────────

/// The server owns the sync state. The client only saves the state it receives as is; it
/// never builds one and sends it back (if it did, files not yet on disk would drop out of
/// the state, and on the next sync every device would read that as "deleted")
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ServerSyncState {
    pub(crate) files: HashMap<String, ServerFileRecord>,
    #[allow(dead_code)]
    pub(crate) last_sync: Option<String>,
    /// Absent from the `new_state` of a bulk response
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

/// A conflict always favors local. The overwritten remote side is set aside under
/// `conflict_key` and comes back in the response, so it is kept locally as a conflict copy too
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
}

/// The ordinary HTTP client, verifying against the OS trust store.
///
/// `Client::new()` panics when the build fails. Sync runs on a user action, so a failed
/// TLS setup is returned as an error instead of crashing.
/// The Android version stays in the app: it needs a config that bypasses the device's
/// verifier, and that decision can only live on the side that knows the platform.
#[cfg(not(target_os = "android"))]
pub fn desktop_http_client() -> Result<reqwest::Client, SyncError> {
    reqwest::Client::builder()
        .build()
        .map_err(|e| SyncError::other(format!("HTTP client setup failed: {}", describe(&e))))
}

/// Everything the sync engine asks of the server.
///
/// `HttpClient` is the only production implementation; this trait exists for the test
/// bench: wired straight to reqwest, there is nowhere to see how many bulks one sync
/// split into. The engine asks the server for only these two things.
///
/// It is written as `impl Future + Send` rather than `async fn` because the sync is
/// spawned on Tauri's multi-threaded runtime. The return of an `async fn` is not `Send`
/// by default, and the whole caller becomes `!Send`.
pub(crate) trait SyncTransport {
    fn get_sync_state(
        &self,
    ) -> impl std::future::Future<Output = Result<ServerSyncState, SyncError>> + Send;
    fn bulk(
        &self,
        req: BulkRequest,
    ) -> impl std::future::Future<Output = Result<BulkResponse, SyncError>> + Send;
}

impl SyncTransport for HttpClient {
    async fn get_sync_state(&self) -> Result<ServerSyncState, SyncError> {
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

    async fn bulk(&self, req: BulkRequest) -> Result<BulkResponse, SyncError> {
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

/// Since reqwest 0.12, `Display` stops at "error sending request for url" plus the URL,
/// and whether DNS, TCP or TLS failed only shows up by walking `source()`.
/// Android's TLS verification goes through Java with no logs, so this chain is the only clue.
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

/// Turns a non-success status into an error with a kind.
/// Skipping this would record a failed upload in the sync state as a success, or write
/// the body of an error response to disk as a note body.
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
