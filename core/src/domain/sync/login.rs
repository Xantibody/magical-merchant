//! Storage of the sync JWT, and its renewal.
//!
//! The keyring crate has no store on Android and falls back to an in-process mock by default.
//! The mock creates an empty container per Entry, so a stored token can never be read back
//! (the app stays "not logged in" right after login). Android alone keeps it in a file in the
//! app-private directory. The OS blocks access between apps, so other apps cannot read it.

use std::path::Path;

use super::token::renewal_due;
use crate::error::SyncError;
use crate::services::worker::TokenRenewer;

#[cfg(target_os = "android")]
mod token_store {
    use std::path::{Path, PathBuf};

    use crate::error::CoreError;
    use crate::services::files;

    const TOKEN_FILENAME: &str = "auth-token";

    fn path(base_dir: &Path) -> PathBuf {
        base_dir.join(TOKEN_FILENAME)
    }

    /// The bare OS message, as `std::fs` gave it before these calls went through `files`:
    /// `CoreError`'s `Display` would put `IO error: ` in front.
    fn plain(e: CoreError) -> String {
        match e {
            CoreError::Io(e) => e.to_string(),
            other => other.to_string(),
        }
    }

    pub(super) fn store(base_dir: &Path, token: &str) -> Result<(), String> {
        let path = path(base_dir);
        files::ensure_dir(&path).map_err(plain)?;
        files::write_owner_only(&path, token).map_err(|e| e.to_string())
    }

    pub(super) fn get(base_dir: &Path) -> Result<Option<String>, String> {
        let token = files::read_if_present(&path(base_dir)).map_err(plain)?;
        Ok(token
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty()))
    }

    pub(super) fn clear(base_dir: &Path) -> Result<(), String> {
        files::remove_if_present(&path(base_dir)).map_err(plain)
    }
}

#[cfg(not(target_os = "android"))]
mod token_store {
    use std::path::Path;

    use crate::services::keyring;

    const KEYCHAIN_SERVICE: &str = "com.magical-merchant.app";
    const KEYCHAIN_ACCOUNT: &str = "auth-jwt";

    pub(super) fn store(_base_dir: &Path, token: &str) -> Result<(), String> {
        keyring::store(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, token)
    }

    pub(super) fn get(_base_dir: &Path) -> Result<Option<String>, String> {
        keyring::get(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
    }

    pub(super) fn clear(_base_dir: &Path) -> Result<(), String> {
        keyring::clear(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
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
    use crate::utils::clock::unix_seconds_now;
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    /// A token issued at `iat` that expires at `exp`. Nobody looks at the signature, so
    /// the three parts are assembled by hand (the same trick as the tests in `token.rs`).
    fn make_jwt_issued(iat: i64, exp: i64) -> String {
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
        let claims = URL_SAFE_NO_PAD.encode(format!(r#"{{"exp":{exp},"iat":{iat}}}"#));
        format!("{header}.{claims}.not-a-real-signature")
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
        let now = unix_seconds_now();
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
        let now = unix_seconds_now();
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
        let now = unix_seconds_now();
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
        let now = unix_seconds_now();
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
}
