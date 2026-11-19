//! How a refused command crosses to the webview.

/// A failed save. It carries a mark the frontend branches on.
///
/// - `stale`: someone wrote after this read. Read again and tell the user
/// - `broken`: the record at the head of the note cannot be read and core refused
///   the write. Set the typed text aside and tell the user: no amount of rewriting
///   will get through
/// - `missing`: the note is gone (deleted, or moved to Codex). Core does not
///   recreate it, so set the typed text aside here as well and tell the user
/// - `notText`: the file content does not read as text (invalid UTF-8). It is kept
///   apart from `broken` because it means something else and calls for something
///   else: rewriting the record does not fix it, and reopening cannot read the body
///   either, so there is no way out through "restore"
#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct SaveError {
    pub(crate) kind: &'static str,
    pub(crate) message: String,
}

impl SaveError {
    /// Failures that never reached core (the data directory cannot be resolved, the
    /// filename is not a note name). There is no mark that tells them apart, so they
    /// fall to `other`.
    pub(crate) const fn other(message: String) -> Self {
        Self {
            kind: "other",
            message,
        }
    }
}

impl From<magical_merchant_core::CoreError> for SaveError {
    fn from(e: magical_merchant_core::CoreError) -> Self {
        Self {
            kind: match e {
                magical_merchant_core::CoreError::Stale(_) => "stale",
                magical_merchant_core::CoreError::Parse(_) => "broken",
                magical_merchant_core::CoreError::NotFound(_) => "missing",
                magical_merchant_core::CoreError::NotText(_) => "notText",
                _ => "other",
            },
            message: e.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A save to a note that is not text is a refusal reading again will not fix.
    ///
    /// Dropping it into `other` makes the screen treat it as a temporary failure and
    /// discard it silently, and the typed text is closed away with no warning, left
    /// neither on disk nor in a backup.
    #[test]
    fn a_note_that_is_not_text_is_refused_under_its_own_mark() {
        let not_text = SaveError::from(magical_merchant_core::CoreError::NotText(
            "a.md".to_string(),
        ));
        // A temporary failure stays without a mark. The next keystroke may still get
        // through, so it is not one to set aside and call unwritable
        let io = SaveError::from(magical_merchant_core::CoreError::Io(std::io::Error::other(
            "disk full",
        )));

        assert_eq!(not_text.kind, "notText");
        assert_eq!(io.kind, "other");
    }
}
