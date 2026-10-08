//! Storage of the sync JWT and the expiry check.
//!
//! The keyring crate has no store on Android and falls back to an in-process mock by default.
//! The mock creates an empty container per Entry, so a stored token can never be read back
//! (the app stays "not logged in" right after login). Android alone keeps it in a file in the
//! app-private directory. The OS blocks access between apps, so other apps cannot read it.

use std::path::Path;

use jsonwebtoken::dangerous::insecure_decode;
use serde::{Deserialize, Serialize};

use super::SyncError;

#[cfg(target_os = "android")]
mod token_store {
    use std::fs;
    use std::os::unix::fs::PermissionsExt as _;
    use std::path::{Path, PathBuf};

    const TOKEN_FILENAME: &str = "auth-token";

    fn path(base_dir: &Path) -> PathBuf {
        base_dir.join(TOKEN_FILENAME)
    }

    pub(super) fn store(base_dir: &Path, token: &str) -> Result<(), String> {
        fs::create_dir_all(base_dir).map_err(|e| e.to_string())?;
        let path = path(base_dir);
        crate::utils::fs::write_atomic(&path, token).map_err(|e| e.to_string())?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())
    }

    pub(super) fn get(base_dir: &Path) -> Result<Option<String>, String> {
        match fs::read_to_string(path(base_dir)) {
            Ok(token) => Ok(Some(token.trim().to_string()).filter(|t| !t.is_empty())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub(super) fn clear(base_dir: &Path) -> Result<(), String> {
        match fs::remove_file(path(base_dir)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(not(target_os = "android"))]
mod token_store {
    use std::path::Path;

    const KEYCHAIN_SERVICE: &str = "com.magical-merchant.app";
    const KEYCHAIN_ACCOUNT: &str = "auth-jwt";

    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())
    }

    pub(super) fn store(_base_dir: &Path, token: &str) -> Result<(), String> {
        entry()?.set_password(token).map_err(|e| e.to_string())
    }

    pub(super) fn get(_base_dir: &Path) -> Result<Option<String>, String> {
        match entry()?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub(super) fn clear(_base_dir: &Path) -> Result<(), String> {
        match entry()?.delete_credential() {
            // Deleting a credential that was never stored leaves the desired state.
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

pub fn store_token(base_dir: &Path, token: &str) -> Result<(), String> {
    token_store::store(base_dir, token)
}

pub fn get_token(base_dir: &Path) -> Result<Option<String>, String> {
    token_store::get(base_dir)
}

pub fn clear_token(base_dir: &Path) -> Result<(), String> {
    token_store::clear(base_dir)
}

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    exp: i64,
    /// Stamped by the Worker since renewal exists. Absent on tokens from before
    #[serde(default, skip_serializing_if = "Option::is_none")]
    iat: Option<i64>,
}

/// Does not verify the signature. The key exists only on the Worker side, and all this
/// needs to know is "is the token still usable". The Worker holds the real decision.
#[must_use]
pub fn is_token_valid(token: &str) -> bool {
    let Ok(token_data) = insecure_decode::<Claims>(token) else {
        return false;
    };

    let now = chrono::Utc::now().timestamp();
    // 5 minute buffer
    token_data.claims.exp > now + 300
}

/// Whether a still-valid token should be traded for a fresh one on this sync.
///
/// Due once half the lifetime (`exp - iat`) is behind it. The lifetime is read off the
/// token, so the client never has to be told the Worker's setting. A token without `iat`
/// predates renewal and is due at once; garbage is not due, the validity check refuses it.
#[must_use]
pub fn renewal_due(token: &str) -> bool {
    let Ok(token_data) = insecure_decode::<Claims>(token) else {
        return false;
    };
    let Claims { exp, iat } = token_data.claims;
    let Some(iat) = iat else {
        return true;
    };
    let now = chrono::Utc::now().timestamp();
    (exp - now) * 2 <= exp - iat
}

/// What a renewal asks of the server: one call, a fresh token back.
///
/// `HttpClient` is the only production implementation; the trait is here so the decision
/// around the call can be tested without a server. Spelled as `impl Future + Send` for the
/// same reason as `SyncTransport`
pub trait TokenRenewer {
    fn renew(&self) -> impl std::future::Future<Output = Result<String, SyncError>> + Send;
}

/// Trades a token past half its lifetime for a fresh one, and stores it.
///
/// `Ok(Some(fresh))` renewed and stored; `Ok(None)` not due, or the server could not be
/// reached (the token in hand still works, so the sync goes on and the next one asks
/// again). `Err` only when the server refused (`notAuthenticated`), which is a login
/// failure like any other, or when the fresh token could not be stored: silently going on
/// would renew on every sync and hide a broken keychain.
///
/// The store is a parameter so this can be tried without opening the Keychain
pub async fn renew_if_due<R, S>(
    token: &str,
    server: &R,
    store: S,
) -> Result<Option<String>, SyncError>
where
    R: TokenRenewer + Sync,
    S: FnOnce(&str) -> Result<(), String>,
{
    if !renewal_due(token) {
        return Ok(None);
    }
    let fresh = match server.renew().await {
        Ok(fresh) => fresh,
        Err(refused) if refused.kind == "notAuthenticated" => return Err(refused),
        Err(_) => return Ok(None),
    };
    store(&fresh)
        .map_err(|e| SyncError::other(format!("Renewed login could not be stored: {e}")))?;
    Ok(Some(fresh))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    /// Nobody looks at the signature, so neither a key nor a crypto backend is needed.
    /// Calling jsonwebtoken's `encode` would pull in a signing implementation only for
    /// the tests, so the three parts are assembled by hand.
    fn make_jwt(exp: i64) -> String {
        jwt_with(&Claims { exp, iat: None })
    }

    fn make_jwt_issued(iat: i64, exp: i64) -> String {
        jwt_with(&Claims {
            exp,
            iat: Some(iat),
        })
    }

    fn jwt_with(claims: &Claims) -> String {
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
        let claims = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap());
        format!("{header}.{claims}.not-a-real-signature")
    }

    // The Worker renews a login that is still valid. Asking on every sync would be a request
    // per sync for nothing; asking only near the end would miss a device that syncs weekly.
    // Halfway through the lifetime is the compromise, and the lifetime is read off the token
    #[test]
    fn a_fresh_token_is_not_due_for_renewal() {
        let now = chrono::Utc::now().timestamp();
        assert!(!renewal_due(&make_jwt_issued(now, now + 100)));
    }

    #[test]
    fn a_token_past_half_its_lifetime_is_due() {
        let now = chrono::Utc::now().timestamp();
        assert!(renewal_due(&make_jwt_issued(now - 60, now + 40)));
    }

    /// Exactly at the halfway mark counts as due: a check that runs a moment later than
    /// the token's own clock would otherwise flip the verdict
    #[test]
    fn a_token_exactly_at_half_is_due() {
        let now = chrono::Utc::now().timestamp();
        assert!(renewal_due(&make_jwt_issued(now - 50, now + 50)));
    }

    /// A token from before the Worker stamped `iat` has no lifetime to read. Renewing it
    /// on the first sync is how it gets one
    #[test]
    fn a_token_without_an_issue_time_is_due() {
        let now = chrono::Utc::now().timestamp();
        assert!(renewal_due(&make_jwt(now + 3600)));
    }

    /// Nothing to renew. The validity check refuses it first, and this must not undo that
    #[test]
    fn garbage_is_not_due() {
        assert!(!renewal_due("not-a-jwt"));
    }

    /// A server that answers from a script. Counts the calls, so a test can say "not asked".
    struct ScriptedRenewer {
        answer: Result<String, SyncError>,
        calls: std::sync::atomic::AtomicUsize,
    }

    impl ScriptedRenewer {
        fn answering(answer: Result<String, SyncError>) -> Self {
            Self {
                answer,
                calls: std::sync::atomic::AtomicUsize::new(0),
            }
        }

        fn calls(&self) -> usize {
            self.calls.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl TokenRenewer for ScriptedRenewer {
        fn renew(&self) -> impl std::future::Future<Output = Result<String, SyncError>> + Send {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            std::future::ready(self.answer.clone())
        }
    }

    fn remember(
        into: &std::cell::RefCell<Option<String>>,
    ) -> impl FnOnce(&str) -> Result<(), String> + '_ {
        move |token| {
            *into.borrow_mut() = Some(token.to_string());
            Ok(())
        }
    }

    #[tokio::test]
    async fn a_token_that_is_not_due_is_left_alone() {
        let now = chrono::Utc::now().timestamp();
        let token = make_jwt_issued(now, now + 1000);
        let server = ScriptedRenewer::answering(Ok("fresh".to_string()));
        let stored = std::cell::RefCell::new(None);

        let renewed = renew_if_due(&token, &server, remember(&stored))
            .await
            .unwrap();

        assert_eq!(renewed, None);
        assert_eq!(server.calls(), 0);
        assert_eq!(*stored.borrow(), None);
    }

    #[tokio::test]
    async fn a_due_token_is_traded_and_the_fresh_one_stored() {
        let now = chrono::Utc::now().timestamp();
        let token = make_jwt_issued(now - 900, now + 100);
        let server = ScriptedRenewer::answering(Ok("fresh".to_string()));
        let stored = std::cell::RefCell::new(None);

        let renewed = renew_if_due(&token, &server, remember(&stored))
            .await
            .unwrap();

        assert_eq!(renewed.as_deref(), Some("fresh"));
        assert_eq!(stored.borrow().as_deref(), Some("fresh"));
    }

    /// Offline, or the Worker is down. The token in hand is still good for a while, so the
    /// sync goes on with it and the next sync asks again
    #[tokio::test]
    async fn an_unreachable_server_leaves_the_token_in_hand() {
        let now = chrono::Utc::now().timestamp();
        let token = make_jwt_issued(now - 900, now + 100);
        let server =
            ScriptedRenewer::answering(Err(SyncError::new("network", "Network error: timeout")));
        let stored = std::cell::RefCell::new(None);

        let renewed = renew_if_due(&token, &server, remember(&stored))
            .await
            .unwrap();

        assert_eq!(renewed, None);
        assert_eq!(*stored.borrow(), None);
    }

    /// The Worker said no (the session bound, or a rotated secret). That is a login failure
    /// like any other and the caller reports it as one
    #[tokio::test]
    async fn a_refusal_is_passed_on() {
        let now = chrono::Utc::now().timestamp();
        let token = make_jwt_issued(now - 900, now + 100);
        let server = ScriptedRenewer::answering(Err(SyncError::new(
            "notAuthenticated",
            "The server rejected the login.",
        )));
        let stored = std::cell::RefCell::new(None);

        let err = renew_if_due(&token, &server, remember(&stored))
            .await
            .unwrap_err();

        assert_eq!(err.kind, "notAuthenticated");
        assert_eq!(*stored.borrow(), None);
    }

    #[test]
    fn valid_token_not_expired() {
        let future = chrono::Utc::now().timestamp() + 3600;
        assert!(is_token_valid(&make_jwt(future)));
    }

    #[test]
    fn expired_token() {
        let past = chrono::Utc::now().timestamp() - 100;
        assert!(!is_token_valid(&make_jwt(past)));
    }

    #[test]
    fn token_expiring_within_buffer() {
        let soon = chrono::Utc::now().timestamp() + 60; // Within 5min buffer
        assert!(!is_token_valid(&make_jwt(soon)));
    }

    /// Exactly at the buffer (`exp == now + 300`) does not count as "still usable". The check
    /// is `>`, so the verdict stays the same even if the check's now is later than the test's now.
    #[test]
    fn a_token_expiring_exactly_at_the_buffer_is_not_valid() {
        let at_buffer = chrono::Utc::now().timestamp() + 300;
        assert!(!is_token_valid(&make_jwt(at_buffer)));
    }

    #[test]
    fn invalid_token_format() {
        assert!(!is_token_valid("not-a-jwt"));
        assert!(!is_token_valid("a.b"));
        assert!(!is_token_valid(""));
    }
}
