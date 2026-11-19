//! The sign-in callback, waited for on 127.0.0.1: accepting connections, reading each one,
//! taking the token out of the request and answering the browser.

use magical_merchant_core::domain::sync::token::is_token_valid;
use url::Url;

/// The only page returned to the browser. The app closes the window right after, so it
/// carries nothing but a note.
const CALLBACK_RESPONSE: &str = concat!(
    "HTTP/1.1 200 OK\r\n",
    "Content-Type: text/html; charset=utf-8\r\n",
    "Connection: close\r\n\r\n",
    "<html><body><p>You can close this window.</p></body></html>"
);

/// The reply to a request that arrives while waiting and is not the callback.
const NOT_FOUND_RESPONSE: &str = "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n";

/// Reads out of a raw HTTP request only a token that may be stored.
///
/// The loopback socket is open for the whole of sign-in, and any local process can hit
/// it. The nonce in the path is the only proof that this is the return of the sign-in
/// started from this window, and the JWT expiry is the minimum check that its contents
/// are usable.
fn callback_token(request_text: &str, callback_path: &str) -> Option<String> {
    let target = request_text.lines().next()?.split_whitespace().nth(1)?;
    // AIDEV-NOTE: drop request targets in absolute URL form. `join` replaces the host too, so the path alone could be made to match
    if !target.starts_with('/') {
        return None;
    }
    let url = Url::parse("http://127.0.0.1/").ok()?.join(target).ok()?;
    if url.path() != callback_path {
        return None;
    }
    url.query_pairs()
        .find(|(key, _)| key == "token")
        .map(|(_, value)| value.into_owned())
        .filter(|token| is_token_valid(token))
}

/// How long one connection may be held.
///
/// A browser sends its request right after it connects, so this is enough for the real
/// one. Reads run in parallel, so raising this limit does not delay accepting the
/// callback; it only moves when a silent connection is dropped.
pub(crate) const CONNECTION_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Reads one accepted connection and returns only a token that may be stored. A reply
/// is written either way: the note for the real one, 404 for everything else.
async fn read_callback_token(
    mut stream: tokio::net::TcpStream,
    callback_path: &str,
    read_timeout: std::time::Duration,
) -> Option<String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut buf = vec![0u8; 4096];
    // Do not hold on to a connection that stays open and sends nothing. A timeout and
    // a failed read are both reasons to drop this one
    let Ok(Ok(n)) = tokio::time::timeout(read_timeout, stream.read(&mut buf)).await else {
        return None;
    };
    let token = callback_token(&String::from_utf8_lossy(&buf[..n]), callback_path);

    let response = if token.is_some() {
        CALLBACK_RESPONSE
    } else {
        NOT_FOUND_RESPONSE
    };
    let _ = stream.write_all(response.as_bytes()).await;

    token
}

/// Waits until a callback with a matching nonce arrives.
///
/// Anything that does not match is dropped with a 404 and the wait goes on, so merely
/// connecting first does not let someone take over the sign-in.
///
/// Reads run in parallel and accepting never stops. The port can be found by brute
/// force, so a local process can open as many connections as it likes.
///
/// AIDEV-NOTE: connections are read in parallel. Reading them in order was rejected: 60 silent connections alone could eat the whole 300-second window
pub(crate) async fn accept_callback_token(
    listener: &tokio::net::TcpListener,
    callback_path: &str,
    read_timeout: std::time::Duration,
) -> Result<String, String> {
    let mut reading = tokio::task::JoinSet::new();

    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted
                    .map_err(|e| format!("Failed to accept connection: {e}"))?;
                let callback_path = callback_path.to_owned();
                reading.spawn(async move {
                    read_callback_token(stream, &callback_path, read_timeout).await
                });
            }
            // A connection that turned out invalid is only a reason to wait for the
            // next. An empty `JoinSet` returns `None` at once, so that round drops this
            // arm and waits on `accept` alone
            Some(read) = reading.join_next() => {
                if let Ok(Some(token)) = read {
                    return Ok(token);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    const CALLBACK_PATH: &str = "/callback/11111111-2222-3333-4444-555555555555";

    /// Nobody looks at the signature (same reason as `domain::sync::token::is_token_valid`), so
    /// the three parts are built directly
    fn jwt(expires_in: i64) -> String {
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
        let exp = magical_merchant_core::utils::clock::unix_seconds_now() + expires_in;
        let claims = URL_SAFE_NO_PAD.encode(format!(r#"{{"exp":{exp}}}"#));
        format!("{header}.{claims}.not-a-real-signature")
    }

    fn get(target: &str) -> String {
        format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
    }

    #[test]
    fn the_token_on_the_callback_path_is_taken() {
        let token = jwt(3600);
        let request = get(&format!("{CALLBACK_PATH}?token={token}"));

        assert_eq!(callback_token(&request, CALLBACK_PATH), Some(token));
    }

    /// A caller that does not know the nonce gets nothing even if it connects first.
    /// Getting this wrong points every later sync at their account
    #[test]
    fn a_token_on_another_path_is_ignored() {
        let request = get(&format!("/callback?token={}", jwt(3600)));

        assert_eq!(callback_token(&request, CALLBACK_PATH), None);
    }

    /// Storing an expired token destroys a live one and then stops the next sync with
    /// "please sign in again"
    #[test]
    fn an_expired_token_is_ignored() {
        let request = get(&format!("{CALLBACK_PATH}?token={}", jwt(-100)));

        assert_eq!(callback_token(&request, CALLBACK_PATH), None);
    }

    #[test]
    fn a_malformed_token_is_ignored() {
        let request = get(&format!("{CALLBACK_PATH}?token=not-a-jwt"));

        assert_eq!(callback_token(&request, CALLBACK_PATH), None);
    }

    #[test]
    fn a_request_without_a_token_is_ignored() {
        assert_eq!(callback_token(&get(CALLBACK_PATH), CALLBACK_PATH), None);
    }

    /// A request line in absolute URL form could be made to match on the path alone
    #[test]
    fn an_absolute_request_target_is_ignored() {
        let request = get(&format!(
            "http://evil.example{CALLBACK_PATH}?token={}",
            jwt(3600)
        ));

        assert_eq!(callback_token(&request, CALLBACK_PATH), None);
    }

    #[test]
    fn a_request_that_is_not_http_is_ignored() {
        assert_eq!(callback_token("", CALLBACK_PATH), None);
        assert_eq!(callback_token("garbage", CALLBACK_PATH), None);
    }

    /// The port can be found by brute force.
    ///
    /// If one local process that connects and sends nothing were enough to block
    /// sign-in, the nonce would still hold but the user would wait out the outer
    /// 5 minutes
    #[tokio::test]
    async fn a_silent_connection_does_not_hold_up_the_callback() {
        use tokio::io::AsyncWriteExt as _;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        // accept order is connection order, so the silent one comes out first
        let _silent = tokio::net::TcpStream::connect(addr).await.unwrap();

        let token = jwt(3600);
        let mut browser = tokio::net::TcpStream::connect(addr).await.unwrap();
        browser
            .write_all(get(&format!("{CALLBACK_PATH}?token={token}")).as_bytes())
            .await
            .unwrap();

        let accepted = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            accept_callback_token(
                &listener,
                CALLBACK_PATH,
                std::time::Duration::from_millis(50),
            ),
        )
        .await
        .expect("the silent connection must not keep the callback waiting");

        assert_eq!(accepted, Ok(token));
    }

    /// Lining up silent connections has the same effect as letting one sit forever.
    ///
    /// Read one at a time, they delay accepting the callback by the read timeout times
    /// the number lined up, which can eat the whole outer 5 minutes
    #[tokio::test]
    async fn many_silent_connections_do_not_hold_up_the_callback() {
        use tokio::io::AsyncWriteExt as _;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        // 60 connections at 5 seconds each is 300 seconds: the real read timeout, as
        // long as the outer window
        let mut silent = Vec::new();
        for _ in 0..60 {
            silent.push(tokio::net::TcpStream::connect(addr).await.unwrap());
        }

        let token = jwt(3600);
        let mut browser = tokio::net::TcpStream::connect(addr).await.unwrap();
        browser
            .write_all(get(&format!("{CALLBACK_PATH}?token={token}")).as_bytes())
            .await
            .unwrap();

        let accepted = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            accept_callback_token(&listener, CALLBACK_PATH, CONNECTION_READ_TIMEOUT),
        )
        .await
        .expect("queued silent connections must not delay the callback");

        assert_eq!(accepted, Ok(token));
        // Lining them up means nothing unless they stay connected for the whole wait
        drop(silent);
    }

    /// Even when several with the wrong nonce are read first, the waiting side takes
    /// only the one that matches.
    ///
    /// Reading in parallel returns "invalid" more than once, so this pins down that
    /// none of those ends the wait
    #[tokio::test]
    async fn the_valid_token_wins_over_connections_read_alongside_it() {
        use tokio::io::AsyncWriteExt as _;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let stolen = jwt(3600);
        let mut impostors = Vec::new();
        for _ in 0..10 {
            let mut impostor = tokio::net::TcpStream::connect(addr).await.unwrap();
            impostor
                .write_all(get(&format!("/callback/other?token={stolen}")).as_bytes())
                .await
                .unwrap();
            impostors.push(impostor);
        }

        let token = jwt(3600);
        let mut browser = tokio::net::TcpStream::connect(addr).await.unwrap();
        browser
            .write_all(get(&format!("{CALLBACK_PATH}?token={token}")).as_bytes())
            .await
            .unwrap();

        let accepted = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            accept_callback_token(&listener, CALLBACK_PATH, CONNECTION_READ_TIMEOUT),
        )
        .await
        .expect("a mismatched nonce must not end the wait");

        assert_eq!(accepted, Ok(token));
        drop(impostors);
    }
}
