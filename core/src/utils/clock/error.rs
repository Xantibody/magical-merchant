use std::fmt;

/// A time or date that does not read.
///
/// Its words reach the screen and MCP as they are (`input is out of range`, `trailing
/// input` and the rest), so they are chrono's, word for word: the parser here is a port of
/// chrono's, and its error is decided at the same step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClockError(pub(super) Kind);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    /// A field past its range, a date that does not exist, an offset of a day or more.
    OutOfRange,
    /// Fields that contradict each other, or an instant past the end of the range.
    Impossible,
    /// A field the value needs is missing.
    NotEnough,
    /// A character where it cannot be.
    Invalid,
    /// The text ends before the value does.
    TooShort,
    /// Text left over after the value.
    TooLong,
}

impl fmt::Display for ClockError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self.0 {
            Kind::OutOfRange => "input is out of range",
            Kind::Impossible => "no possible date and time matching input",
            Kind::NotEnough => "input is not enough for unique date and time",
            Kind::Invalid => "input contains invalid characters",
            Kind::TooShort => "premature end of input",
            Kind::TooLong => "trailing input",
        })
    }
}

impl std::error::Error for ClockError {}

impl From<Kind> for ClockError {
    fn from(kind: Kind) -> Self {
        Self(kind)
    }
}
