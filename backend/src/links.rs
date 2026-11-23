//! Entry: the OS opened the app with a `magical-merchant://` link.
//!
//! Two kinds count. The login's callback carries the token to store. A
//! `magical-merchant://scrawl?text=…` link writes the line with no window at all (78): that is
//! what a Shortcut run from Spotlight opens, and an empty one opens the one-line window
//! instead. The widget's own links share the scheme and are read by neither.

use magical_merchant_core::domain::device::{ClientContext, probe_with_client};
use tauri::{AppHandle, Emitter};

use crate::services::core_location;
use crate::services::tauri::app_base_dir;
#[cfg(desktop)]
use crate::services::windows::show_capture_window;
use crate::services::windows::tell_scrawl_captured;

/// Every link the app is opened with: the login's callback, and a Scrawl line from Spotlight or
/// a Shortcut (78), which is written before any page could be asked.
pub(crate) fn on_links(handle: &AppHandle, urls: &[url::Url]) {
    store_token_from_urls(handle, urls);
    scrawl_from_urls(handle, urls);
}

/// Takes from a deep link only the JWT that may be stored.
///
/// The widget's own `magical-merchant://widget/` links arrive on the same scheme,
/// so a `?token=` alone is not enough. Only links whose host is `auth` count, and
/// the value has to be a live JWT as well: storing an expired one overwrites a
/// valid token and leaves the next sync stopped at "please log in again"
fn token_from_urls(urls: &[url::Url]) -> Option<String> {
    urls.iter()
        .filter(|url| url.host_str() == Some("auth"))
        .flat_map(url::Url::query_pairs)
        .filter(|(key, _)| key == "token")
        .map(|(_, value)| value.into_owned())
        .find(|token| magical_merchant_core::domain::sync::token::is_token_valid(token))
}

/// Stores the JWT that came back from the OAuth callback.
///
/// Without telling the frontend the result, a completed login never reaches the UI
/// and a failure is swallowed.
///
/// On Android `app_data_dir` is a synchronous call into a plugin, and the main
/// thread is what carries its reply. Deep link events are delivered on that same
/// main thread, so calling it directly here waits on its own reply and freezes the
/// whole Activity. Always move it to another thread.
fn store_token_from_urls(handle: &AppHandle, urls: &[url::Url]) {
    let Some(token) = token_from_urls(urls) else {
        return;
    };

    let handle = handle.clone();
    std::thread::spawn(move || {
        let stored = app_base_dir(&handle)
            .and_then(|dir| magical_merchant_core::domain::sync::login::store_token(&dir, &token));

        match stored {
            Ok(()) => {
                let _ = handle.emit("auth-success", ());
            }
            Err(e) => {
                let _ = handle.emit("auth-error", e);
            }
        }
    });
}

/// The line a `magical-merchant://scrawl` link carries, if it is one. `Some("")` is a link with
/// nothing to write, which opens the window instead.
fn link_text(url: &url::Url) -> Option<String> {
    if url.host_str() != Some("scrawl") {
        return None;
    }
    Some(
        url.query_pairs()
            .find(|(key, _)| key == "text")
            .map(|(_, value)| value.trim().to_string())
            .unwrap_or_default(),
    )
}

/// A Scrawl link from Spotlight or a Shortcut (78): the line is written here, before any page
/// could be asked, so it lands even while the app is still starting. An empty one opens the
/// window. Runs off the main thread: the save probes the device and writes a file.
fn scrawl_from_urls(app: &AppHandle, urls: &[url::Url]) {
    for text in urls.iter().filter_map(link_text) {
        if text.is_empty() {
            #[cfg(desktop)]
            show_capture_window(app);
            continue;
        }
        let app = app.clone();
        std::thread::spawn(move || {
            let saved = app_base_dir(&app).and_then(|dir| {
                let context = probe_with_client(ClientContext::default(), core_location::latest);
                magical_merchant_core::save_scrawl_entry(
                    &dir,
                    &text,
                    &context,
                    magical_merchant_core::Source::App,
                )
                .map_err(|e| e.to_string())
            });
            if saved.is_ok() {
                tell_scrawl_captured(&app, "link");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    use super::*;

    /// Nobody checks the signature (same reason as `domain::sync::token::is_token_valid`),
    /// so the three parts are assembled directly
    fn jwt(expires_in: i64) -> String {
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
        let exp = magical_merchant_core::utils::clock::unix_seconds_now() + expires_in;
        let claims = URL_SAFE_NO_PAD.encode(format!(r#"{{"exp":{exp}}}"#));
        format!("{header}.{claims}.not-a-real-signature")
    }

    fn urls(raw: &[String]) -> Vec<url::Url> {
        raw.iter().map(|u| url::Url::parse(u).unwrap()).collect()
    }

    fn url(raw: &str) -> url::Url {
        url::Url::parse(raw).unwrap()
    }

    #[test]
    fn the_auth_callback_token_is_taken() {
        let token = jwt(3600);
        let links = urls(&[format!("magical-merchant://auth/callback?token={token}")]);

        assert_eq!(token_from_urls(&links), Some(token));
    }

    /// A widget deep link arrives on the same scheme. Adding a `?token=` must not
    /// be enough to swap the account things are saved to
    #[test]
    fn a_token_on_a_widget_link_is_ignored() {
        let links = urls(&[format!(
            "magical-merchant://widget/new-note?token={}",
            jwt(3600)
        )]);

        assert_eq!(token_from_urls(&links), None);
    }

    /// Storing an expired token leaves nothing but a state where the next sync
    /// stops at "please log in again", with the valid token overwritten as well
    #[test]
    fn an_expired_or_malformed_token_is_ignored() {
        let expired = urls(&[format!(
            "magical-merchant://auth/callback?token={}",
            jwt(-100)
        )]);
        let garbage = urls(&["magical-merchant://auth/callback?token=not-a-jwt".to_string()]);

        assert_eq!(token_from_urls(&expired), None);
        assert_eq!(token_from_urls(&garbage), None);
    }

    #[test]
    fn a_scrawl_link_carries_its_line() {
        assert_eq!(
            link_text(&url("magical-merchant://scrawl?text=%E7%89%9B%E4%B9%B3%20")),
            Some("牛乳".to_string())
        );
    }

    /// A Shortcut with no text asks for the window rather than an empty record
    #[test]
    fn an_empty_scrawl_link_asks_for_the_window() {
        assert_eq!(
            link_text(&url("magical-merchant://scrawl")),
            Some(String::new())
        );
        assert_eq!(
            link_text(&url("magical-merchant://scrawl?text=")),
            Some(String::new())
        );
    }

    /// The auth callback and the widget links share the scheme and must write nothing
    #[test]
    fn other_links_are_not_lines() {
        assert_eq!(
            link_text(&url("magical-merchant://auth/callback?token=x")),
            None
        );
        assert_eq!(
            link_text(&url("magical-merchant://widget/new-note?text=x")),
            None
        );
    }
}
