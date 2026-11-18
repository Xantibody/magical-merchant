use std::fmt;

/// A time or date that does not read. Its words reach the screen and MCP as they are
/// (`input is out of range`, `trailing input` and the rest), so they are the parser's own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClockError(pub(super) chrono::ParseError);

impl fmt::Display for ClockError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, f)
    }
}

impl std::error::Error for ClockError {}
