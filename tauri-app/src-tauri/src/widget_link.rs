//! `magical-merchant://widget/...` deep links, sent by the home screen widgets.
//!
//! A tap arrives one of two ways, and only one of them can be an event. If the
//! app was already running, `on_open_url` fires while the `WebView` is listening,
//! so [`notify`] emits. If the tap started the app, the launch URL is handled
//! during `setup`, long before anything subscribes — so [`park`] stores it and
//! the frontend picks it up with [`take_widget_action`] on mount.
//!
//! Doing both for one tap would either run it twice or leave a stale action
//! parked, which replays on the *next* cold start.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager as _, State};

/// A tap on a widget, as the frontend sees it.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct WidgetAction {
    /// The URL path without its leading slash: `new-note`, `note`, …
    pub(crate) name: String,
    /// `?file=` — which note to open, for the recent notes list.
    pub(crate) file: Option<String>,
}

#[derive(Debug, Default)]
pub(crate) struct PendingWidgetAction(Mutex<Option<WidgetAction>>);

/// The action the app was started with, if the frontend has not taken it yet.
///
/// Taking rather than reading: a second call after a hot reload would otherwise
/// replay a tap the user made minutes ago.
#[tauri::command]
pub(crate) fn take_widget_action(state: State<'_, PendingWidgetAction>) -> Option<WidgetAction> {
    state.0.lock().ok().and_then(|mut pending| pending.take())
}

/// Stores the launch URL's action for the frontend to take once it mounts.
pub(crate) fn park(handle: &AppHandle, urls: &[url::Url]) {
    let Some(action) = urls.iter().find_map(parse) else {
        return;
    };
    if let Some(state) = handle.try_state::<PendingWidgetAction>() {
        if let Ok(mut pending) = state.0.lock() {
            *pending = Some(action);
        }
    }
}

/// Tells the running frontend about a tap that arrived while it was up.
pub(crate) fn notify(handle: &AppHandle, urls: &[url::Url]) {
    let Some(action) = urls.iter().find_map(parse) else {
        return;
    };
    let _ = handle.emit("widget-open", action);
}

/// `magical-merchant://widget/<name>?file=<filename>`.
fn parse(url: &url::Url) -> Option<WidgetAction> {
    if url.host_str() != Some("widget") {
        return None;
    }

    let name = url.path().trim_start_matches('/');
    if name.is_empty() {
        return None;
    }

    Some(WidgetAction {
        name: name.to_string(),
        file: url
            .query_pairs()
            .find(|(key, _)| key == "file")
            .map(|(_, value)| value.into_owned()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn action(raw: &str) -> Option<WidgetAction> {
        parse(&url::Url::parse(raw).unwrap())
    }

    #[test]
    fn new_note_link_carries_its_name() {
        let parsed = action("magical-merchant://widget/new-note").unwrap();
        assert_eq!(parsed.name, "new-note");
        assert_eq!(parsed.file, None);
    }

    #[test]
    fn note_link_carries_the_filename() {
        let parsed = action("magical-merchant://widget/note?file=20260809_120000.md").unwrap();
        assert_eq!(parsed.name, "note");
        assert_eq!(parsed.file.as_deref(), Some("20260809_120000.md"));
    }

    /// The auth callback shares the scheme and would otherwise navigate the app
    /// away mid-login.
    #[test]
    fn other_hosts_are_not_widget_actions() {
        assert!(action("magical-merchant://auth?token=abc").is_none());
    }

    #[test]
    fn a_bare_widget_host_names_no_action() {
        assert!(action("magical-merchant://widget").is_none());
        assert!(action("magical-merchant://widget/").is_none());
    }
}
