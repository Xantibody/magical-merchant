//! `magical-merchant sync`: syncs with Workers/R2 without opening the app.
//!
//! The syncing itself is one engine in core (`engine::run_with_progress`); what this
//! does is resolve the config and the token, and turn progress into lines. Signing in
//! is still the app's job: the CLI only reads the stored JWT, and if it has expired it
//! says to go back to the app.

use std::path::Path;

use magical_merchant_core::sync::client::{HttpClient, desktop_http_client};
use magical_merchant_core::sync::config::SyncConfig;
use magical_merchant_core::sync::engine::{self, RoundProgress};
use magical_merchant_core::sync::token;
use magical_merchant_core::sync::{SyncError, SyncResult};

#[derive(Debug)]
pub(crate) struct Credentials {
    pub(crate) workers_url: String,
    pub(crate) token: String,
}

/// Resolves the config and the token.
///
/// The order and the `kind` values match the app's `do_sync`: if the same state got a
/// different name, fixing only one side would go unnoticed.
///
/// The token reader is a parameter so that this can be tried without opening the
/// Keychain.
pub(crate) fn credentials<F>(base_dir: &Path, read_token: F) -> Result<Credentials, SyncError>
where
    F: Fn(&Path) -> Result<Option<String>, String>,
{
    let config = SyncConfig::load(base_dir)?.unwrap_or_default();
    if !config.is_configured() {
        return Err(SyncError::new(
            "notConfigured",
            "Sync is not set up. Add your Workers URL in the app's Settings.",
        ));
    }
    let token = read_token(base_dir)
        .map_err(SyncError::other)?
        .ok_or_else(|| {
            SyncError::new(
                "notAuthenticated",
                "Not logged in. Log in from the app's Settings.",
            )
        })?;
    if !token::is_token_valid(&token) {
        return Err(SyncError::new(
            "notAuthenticated",
            "Login expired. Log in again from the app's Settings.",
        ));
    }
    Ok(Credentials {
        workers_url: config.workers_url,
        token,
    })
}

/// One line each time a round finishes. Importing 529 files takes 14 round trips, and
/// with nothing printed it only looks stuck.
fn round_line(progress: &RoundProgress) -> String {
    format!(
        "round {}  {} done, {} left",
        progress.round, progress.done, progress.remaining
    )
}

/// One line once it is over. The symbols are the ones the app displays.
///
/// The zero entries are printed too, not left out. The first use is to check the
/// number of files sent right after an import, and leaving them out makes that
/// impossible to count.
fn summary(result: &SyncResult) -> String {
    let deleted = result.deleted_remote + result.deleted_local;
    if result.uploaded + result.downloaded + deleted + result.conflicts == 0 {
        return "already up to date".to_string();
    }
    let kept = if result.conflicts > 0 {
        format!("  ({} kept as conflict copies)", result.conflicts)
    } else {
        String::new()
    };
    format!(
        "↑{} ↓{} −{deleted}{kept}",
        result.uploaded, result.downloaded
    )
}

pub(crate) async fn run(data_dir: &Path) -> anyhow::Result<()> {
    // The repair that runs before the scan is inside the engine, inside the sync lock.
    // Doing it here first would rewrite the tree while the app is syncing
    let credentials = credentials(data_dir, token::get_token)?;
    let client = HttpClient::new(
        desktop_http_client()?,
        &credentials.workers_url,
        &credentials.token,
    );

    let result = engine::run_with_progress(&client, data_dir, |progress| {
        eprintln!("{}", round_line(&progress));
    })
    .await
    .map_err(|e| describe_failure(&e))?;

    println!("{}", summary(&result));
    // Do not end in success if even one file was missed. The import is checked by the
    // exit code, so returning 0 with the counts off is no good
    if !result.errors.is_empty() {
        for issue in &result.errors {
            eprintln!("{issue}");
        }
        anyhow::bail!("{} file(s) could not be synced", result.errors.len());
    }
    Ok(())
}

/// Turns an engine failure into words the CLI can use.
///
/// `busy` is the one case that goes the other way from the app UI. It is not quietly
/// turned into a success: it says that waiting is all it takes, and ends.
fn describe_failure(err: &SyncError) -> anyhow::Error {
    if err.kind == "busy" {
        return anyhow::anyhow!("the app is syncing right now; wait for it to finish");
    }
    anyhow::anyhow!("{}", err.message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use tempfile::TempDir;

    fn configured() -> TempDir {
        let dir = TempDir::new().unwrap();
        SyncConfig {
            workers_url: "https://example.workers.dev".to_string(),
            auto_sync: false,
        }
        .save(dir.path())
        .unwrap();
        dir
    }

    /// Nobody looks at the signature. `is_token_valid` reads only `exp`, so the three
    /// parts are built directly (the same trick as the tests in
    /// `core/src/sync/token.rs`).
    fn jwt(exp: i64) -> String {
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
        let claims = URL_SAFE_NO_PAD.encode(format!(r#"{{"exp":{exp}}}"#));
        format!("{header}.{claims}.not-a-real-signature")
    }

    #[allow(clippy::unnecessary_wraps, reason = "credentials が求める読み手の形")]
    fn no_token(_: &Path) -> Result<Option<String>, String> {
        Ok(None)
    }

    /// Sync is only configured on the app's screen. Letting the CLI type a URL would
    /// create a sync target that disagrees with the app's setting
    #[test]
    fn without_a_workers_url_it_points_at_the_app() {
        let dir = TempDir::new().unwrap();

        let err = credentials(dir.path(), no_token).unwrap_err();

        assert_eq!(err.kind, "notConfigured");
        assert!(err.message.contains("Settings"), "{}", err.message);
    }

    #[test]
    fn without_a_token_it_asks_for_a_login() {
        let dir = configured();

        let err = credentials(dir.path(), no_token).unwrap_err();

        assert_eq!(err.kind, "notAuthenticated");
    }

    /// Going into a sync with an expired token reaches "log in again" only after the
    /// server refuses it. Look first, and stop with the same words
    #[test]
    fn an_expired_token_is_refused_before_the_network() {
        let dir = configured();
        let expired = jwt(chrono::Utc::now().timestamp() - 100);

        let err = credentials(dir.path(), |_| Ok(Some(expired.clone()))).unwrap_err();

        assert_eq!(err.kind, "notAuthenticated");
        assert!(err.message.contains("expired"), "{}", err.message);
    }

    #[test]
    fn a_live_token_and_a_url_are_what_the_client_needs() {
        let dir = configured();
        let live = jwt(chrono::Utc::now().timestamp() + 3600);

        let ready = credentials(dir.path(), |_| Ok(Some(live.clone()))).unwrap();

        assert_eq!(ready.workers_url, "https://example.workers.dev");
        assert_eq!(ready.token, live);
    }

    /// The import is verified by counting this line. If the zero entries vanish there
    /// is nothing to match it against
    #[test]
    fn the_summary_keeps_every_count_even_at_zero() {
        let result = SyncResult {
            uploaded: 529,
            ..SyncResult::default()
        };

        assert_eq!(summary(&result), "↑529 ↓0 −0");
    }

    #[test]
    fn the_summary_says_so_when_there_was_nothing_to_do() {
        assert_eq!(summary(&SyncResult::default()), "already up to date");
    }

    /// Conflicts are not mixed into the transfer counts. That a copy was kept is said
    /// separately
    #[test]
    fn conflicts_are_reported_next_to_the_counts() {
        let result = SyncResult {
            uploaded: 1,
            conflicts: 2,
            ..SyncResult::default()
        };

        assert_eq!(summary(&result), "↑1 ↓0 −0  (2 kept as conflict copies)");
    }

    #[test]
    fn each_round_prints_what_it_did_and_what_is_left() {
        let line = round_line(&RoundProgress {
            round: 3,
            done: 40,
            remaining: 449,
        });

        assert_eq!(line, "round 3  40 done, 449 left");
    }

    /// The app ignores `busy` silently, but the CLI ends by saying that waiting is
    /// enough. Printing nothing and returning 0 would move on as if it had synced
    #[test]
    fn a_busy_app_is_explained_rather_than_ignored() {
        let err = describe_failure(&SyncError::new("busy", "Sync already in progress"));

        assert!(err.to_string().contains("wait"), "{err}");
    }

    #[test]
    fn other_failures_keep_the_engines_own_words() {
        let err = describe_failure(&SyncError::new("stalled", "Sync stopped making progress"));

        assert_eq!(err.to_string(), "Sync stopped making progress");
    }
}
