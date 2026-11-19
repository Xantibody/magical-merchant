//! The sync JWT's expiry: whether it still works and when to trade it for a fresh one.

use jsonwebtoken::dangerous::insecure_decode;
use serde::{Deserialize, Serialize};

use crate::utils::clock::unix_seconds_now;

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

    let now = unix_seconds_now();
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
    let now = unix_seconds_now();
    (exp - now) * 2 <= exp - iat
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
        let now = unix_seconds_now();
        assert!(!renewal_due(&make_jwt_issued(now, now + 100)));
    }

    #[test]
    fn a_token_past_half_its_lifetime_is_due() {
        let now = unix_seconds_now();
        assert!(renewal_due(&make_jwt_issued(now - 60, now + 40)));
    }

    /// Exactly at the halfway mark counts as due: a check that runs a moment later than
    /// the token's own clock would otherwise flip the verdict
    #[test]
    fn a_token_exactly_at_half_is_due() {
        let now = unix_seconds_now();
        assert!(renewal_due(&make_jwt_issued(now - 50, now + 50)));
    }

    /// A token from before the Worker stamped `iat` has no lifetime to read. Renewing it
    /// on the first sync is how it gets one
    #[test]
    fn a_token_without_an_issue_time_is_due() {
        let now = unix_seconds_now();
        assert!(renewal_due(&make_jwt(now + 3600)));
    }

    /// Nothing to renew. The validity check refuses it first, and this must not undo that
    #[test]
    fn garbage_is_not_due() {
        assert!(!renewal_due("not-a-jwt"));
    }

    #[test]
    fn valid_token_not_expired() {
        let future = unix_seconds_now() + 3600;
        assert!(is_token_valid(&make_jwt(future)));
    }

    #[test]
    fn expired_token() {
        let past = unix_seconds_now() - 100;
        assert!(!is_token_valid(&make_jwt(past)));
    }

    #[test]
    fn token_expiring_within_buffer() {
        let soon = unix_seconds_now() + 60; // Within 5min buffer
        assert!(!is_token_valid(&make_jwt(soon)));
    }

    /// Exactly at the buffer (`exp == now + 300`) does not count as "still usable". The check
    /// is `>`, so the verdict stays the same even if the check's now is later than the test's now.
    #[test]
    fn a_token_expiring_exactly_at_the_buffer_is_not_valid() {
        let at_buffer = unix_seconds_now() + 300;
        assert!(!is_token_valid(&make_jwt(at_buffer)));
    }

    #[test]
    fn invalid_token_format() {
        assert!(!is_token_valid("not-a-jwt"));
        assert!(!is_token_valid("a.b"));
        assert!(!is_token_valid(""));
    }
}
