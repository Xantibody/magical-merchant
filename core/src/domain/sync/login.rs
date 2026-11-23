//! The sync login: storing the JWT, checking there is a live one before a sync, and
//! renewing it.
//!
//! The keyring crate has no store on Android and falls back to an in-process mock by default.
//! The mock creates an empty container per Entry, so a stored token can never be read back
//! (the app stays "not logged in" right after login). Android alone keeps it in a file in the
//! app-private directory. The OS blocks access between apps, so other apps cannot read it.

use std::path::Path;

use super::settings::SyncConfig;
use super::token::{is_token_valid, renewal_due};
use crate::services::worker::{HttpClient, TokenRenewer};
use crate::utils::error::SyncError;

#[cfg(target_os = "android")]
mod token_store {
    use std::path::{Path, PathBuf};

    use crate::services::files;

    const TOKEN_FILENAME: &str = "auth-token";

    fn path(base_dir: &Path) -> PathBuf {
        base_dir.join(TOKEN_FILENAME)
    }

    pub(super) fn store(base_dir: &Path, token: &str) -> Result<(), String> {
        let path = path(base_dir);
        files::ensure_dir(&path).map_err(|e| e.plain_message())?;
        files::write_owner_only(&path, token).map_err(|e| e.to_string())
    }

    pub(super) fn get(base_dir: &Path) -> Result<Option<String>, String> {
        let token = files::read_if_present(&path(base_dir)).map_err(|e| e.plain_message())?;
        Ok(token
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty()))
    }

    pub(super) fn clear(base_dir: &Path) -> Result<(), String> {
        files::remove_if_present(&path(base_dir)).map_err(|e| e.plain_message())
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

/// Where a sync goes and with what: the Workers URL and a live token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Login {
    pub workers_url: String,
    pub token: String,
}

/// Checks that this device is set up and logged in, before a sync reaches the network.
///
/// The kinds (`notConfigured`, `notAuthenticated`) are decided here once for the app and
/// the CLI. The words differ only in where they send the reader to fix it,
/// `settings_place`: "Settings" in the app, "the app's Settings" from the CLI, which never
/// signs in itself.
///
/// The token reader is a parameter so this can be tried without opening the Keychain; the
/// entries pass [`get_token`].
pub fn check_login<F>(
    base_dir: &Path,
    read_token: F,
    settings_place: &str,
) -> Result<Login, SyncError>
where
    F: FnOnce() -> Result<Option<String>, String>,
{
    let config = SyncConfig::load(base_dir)?.unwrap_or_default();
    if !config.is_configured() {
        return Err(SyncError::new(
            "notConfigured",
            format!("Sync is not set up. Add your Workers URL in {settings_place}."),
        ));
    }
    let token = read_token().map_err(SyncError::other)?.ok_or_else(|| {
        SyncError::new(
            "notAuthenticated",
            format!("Not logged in. Log in from {settings_place}."),
        )
    })?;
    // Going into a sync with an expired token reaches "log in again" only after the
    // server refuses it. Look first, and stop with the same words
    if !is_token_valid(&token) {
        return Err(SyncError::new(
            "notAuthenticated",
            format!("Login expired. Log in again from {settings_place}."),
        ));
    }
    Ok(Login {
        workers_url: config.workers_url,
        token,
    })
}

/// The client a sync runs with: the login checked ([`check_login`]), and renewed and
/// stored when it is past half its lifetime, so a device that syncs never signs out.
///
/// `http` builds the HTTP client and comes from the caller, which alone knows the
/// platform's TLS setup. It is called only once the login is checked, so a device never
/// set up hears `notConfigured` even where the client cannot be built (Android's TLS
/// setup failing). Reading and storing the token are parameters for the same reason as in
/// [`check_login`]; the entries pass [`get_token`] and [`store_token`].
pub async fn sync_client<H, F, S>(
    base_dir: &Path,
    http: H,
    settings_place: &str,
    read_token: F,
    store: S,
) -> Result<HttpClient, SyncError>
where
    H: FnOnce() -> Result<reqwest::Client, SyncError>,
    F: FnOnce() -> Result<Option<String>, String>,
    S: FnOnce(&str) -> Result<(), String>,
{
    let login = check_login(base_dir, read_token, settings_place)?;
    let client = HttpClient::new(http()?, &login.workers_url, &login.token);
    Ok(match renew_if_due(&login.token, &client, store).await? {
        Some(fresh) => client.with_token(&fresh),
        None => client,
    })
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
    use tempfile::TempDir;

    fn configured() -> TempDir {
        let dir = TempDir::new().unwrap();
        SyncConfig {
            workers_url: "https://example.workers.dev".to_string(),
            ..SyncConfig::default()
        }
        .save(dir.path())
        .unwrap();
        dir
    }

    /// Nobody looks at the signature. `is_token_valid` reads only `exp`, so the three
    /// parts are built directly (the same trick as the tests in `token.rs`).
    fn jwt(exp: i64) -> String {
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
        let claims = URL_SAFE_NO_PAD.encode(format!(r#"{{"exp":{exp}}}"#));
        format!("{header}.{claims}.not-a-real-signature")
    }

    #[allow(
        clippy::unnecessary_wraps,
        reason = "the shape check_login asks of its reader"
    )]
    const fn no_token() -> Result<Option<String>, String> {
        Ok(None)
    }

    const CLI: &str = "the app's Settings";

    /// Sync is only configured on the app's screen. Letting the CLI type a URL would
    /// create a sync target that disagrees with the app's setting
    #[test]
    fn without_a_workers_url_it_points_at_the_settings() {
        let dir = TempDir::new().unwrap();

        let err = check_login(dir.path(), no_token, CLI).unwrap_err();

        assert_eq!(err.kind, "notConfigured");
        assert!(err.message.contains("Settings"), "{}", err.message);
    }

    #[test]
    fn without_a_token_it_asks_for_a_login() {
        let dir = configured();

        let err = check_login(dir.path(), no_token, CLI).unwrap_err();

        assert_eq!(err.kind, "notAuthenticated");
    }

    /// Going into a sync with an expired token reaches "log in again" only after the
    /// server refuses it. Look first, and stop with the same words
    #[test]
    fn an_expired_token_is_refused_before_the_network() {
        let dir = configured();
        let expired = jwt(unix_seconds_now() - 100);

        let err = check_login(dir.path(), || Ok(Some(expired)), CLI).unwrap_err();

        assert_eq!(err.kind, "notAuthenticated");
        assert!(err.message.contains("expired"), "{}", err.message);
    }

    #[test]
    fn a_live_token_and_a_url_are_what_the_client_needs() {
        let dir = configured();
        let live = jwt(unix_seconds_now() + 3600);

        let login = check_login(dir.path(), || Ok(Some(live.clone())), CLI).unwrap();

        assert_eq!(login.workers_url, "https://example.workers.dev");
        assert_eq!(login.token, live);
    }

    /// The same states in the app's and the CLI's words. The screen shows the message as it
    /// is, so they stay as they were, and only the place to go differs.
    #[test]
    fn the_app_and_the_cli_are_told_the_same_kind_in_their_own_words() {
        let unset = TempDir::new().unwrap();
        let set = configured();
        let expired = jwt(unix_seconds_now() - 100);

        for (place, words) in [
            (
                "Settings",
                [
                    "Sync is not set up. Add your Workers URL in Settings.",
                    "Not logged in. Log in from Settings.",
                    "Login expired. Log in again from Settings.",
                ],
            ),
            (
                CLI,
                [
                    "Sync is not set up. Add your Workers URL in the app's Settings.",
                    "Not logged in. Log in from the app's Settings.",
                    "Login expired. Log in again from the app's Settings.",
                ],
            ),
        ] {
            let told = [
                check_login(unset.path(), no_token, place),
                check_login(set.path(), no_token, place),
                check_login(set.path(), || Ok(Some(expired.clone())), place),
            ]
            .map(|refused| {
                let err = refused.unwrap_err();
                (err.kind, err.message)
            });

            assert_eq!(
                told,
                [
                    ("notConfigured", words[0].to_string()),
                    ("notAuthenticated", words[1].to_string()),
                    ("notAuthenticated", words[2].to_string()),
                ],
                "{place}"
            );
        }
    }

    /// A login that is not due is used as it is: nothing is stored and nothing is asked
    /// of the server.
    #[tokio::test]
    async fn a_live_login_that_is_not_due_makes_a_client_without_renewing() {
        let dir = configured();
        let now = unix_seconds_now();
        let live = make_jwt_issued(now, now + 1000);
        let stored = std::cell::RefCell::new(None);

        let client = sync_client(
            dir.path(),
            || Ok(reqwest::Client::new()),
            "Settings",
            || Ok(Some(live)),
            remember(&stored),
        )
        .await;

        assert!(client.is_ok());
        assert_eq!(*stored.borrow(), None);
    }

    /// A device never set up is told so even where the HTTP client cannot be built (on
    /// Android a TLS setup that fails): the client is built only after the login check, so
    /// `notConfigured` does not turn into `other`.
    #[tokio::test]
    async fn an_unconfigured_device_is_told_so_before_the_client_is_built() {
        let dir = TempDir::new().unwrap();
        let built = std::cell::Cell::new(false);
        let stored = std::cell::RefCell::new(None);

        let refused = sync_client(
            dir.path(),
            || {
                built.set(true);
                Err(SyncError::other("TLS setup failed"))
            },
            "Settings",
            no_token,
            remember(&stored),
        )
        .await
        .map(|_| ())
        .unwrap_err();

        assert_eq!(refused.kind, "notConfigured");
        assert!(!built.get());
    }

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
