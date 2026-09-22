//! Storage of the sync JWT and the expiry check.
//!
//! The keyring crate has no store on Android and falls back to an in-process mock by default.
//! The mock creates an empty container per Entry, so a stored token can never be read back
//! (the app stays "not logged in" right after login). Android alone keeps it in a file in the
//! app-private directory. The OS blocks access between apps, so other apps cannot read it.

use std::path::Path;

use jsonwebtoken::dangerous::insecure_decode;
use serde::{Deserialize, Serialize};

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

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    /// Nobody looks at the signature, so neither a key nor a crypto backend is needed.
    /// Calling jsonwebtoken's `encode` would pull in a signing implementation only for
    /// the tests, so the three parts are assembled by hand.
    fn make_jwt(exp: i64) -> String {
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
        let claims = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&Claims { exp }).unwrap());
        format!("{header}.{claims}.not-a-real-signature")
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
