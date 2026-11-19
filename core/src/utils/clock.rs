//! Every time the app reads, writes or takes from the device goes through here.
//!
//! The types are opaque: no caller sees the library behind them, and each spelling that is
//! persisted or sent (a note's `time:`, an ID stem, a day file's name, the Worker's
//! `last_modified`, an MCP field) has one named function here. A change of time library
//! then touches only this module, and the bytes on disk and on the wire are pinned by the
//! tests of the callers that write them.
//!
//! AIDEV-NOTE: the values, printers and parsers are this module's own, ported from chrono
//! 0.4.45 (#415 replaced it); jiff only says which offset a zone puts on an instant.
//! jiff's types cannot hold what chrono read and wrote (a leap second, a year past 9999),
//! and its printers and parsers spell and accept other bytes. Wrapping jiff's `Timestamp`
//! and refusing what it cannot hold was the plan, but the pinned frontmatter and ID tables
//! keep `+10000-…` and `:60` readable, so the range stays chrono's instead.

mod civil;
mod error;
#[cfg(test)]
mod golden;
mod parse;
mod posix;
mod stamp;
mod zone;

pub use civil::{Day, Time, WallClock};
pub use error::ClockError;
pub use stamp::{Stamp, UtcStamp, unix_seconds_now};
pub use zone::Zone;
