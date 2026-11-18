//! Every time the app reads, writes or takes from the device goes through here.
//!
//! The types are opaque: no caller sees the library behind them, and each spelling that is
//! persisted or sent (a note's `time:`, an ID stem, a day file's name, the Worker's
//! `last_modified`, an MCP field) has one named function here. A change of time library
//! then touches only this module, and the bytes on disk and on the wire are pinned by the
//! tests of the callers that write them.
//!
//! AIDEV-NOTE: backed by chrono for now (#415 replaces it); serde and every printer
//! delegate to chrono's own so the bytes stay chrono's.

mod civil;
mod error;
#[cfg(test)]
mod golden;
mod stamp;
mod zone;

pub use civil::{Day, Time, WallClock};
pub use error::ClockError;
pub use stamp::{Stamp, UtcStamp};
pub use zone::Zone;

/// Whole seconds since the Unix epoch, now. What a JWT's `exp` / `iat` is compared with.
#[must_use]
pub fn unix_seconds_now() -> i64 {
    UtcStamp::now().unix_seconds()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Frozen from chrono 0.4.45. The fraction keeps 0, 3, 6 or 9 digits, never trimmed;
    /// a zero offset is `Z` only in `rfc3339_z`.
    #[test]
    fn rfc3339_keeps_whole_digit_groups_and_spells_zero_two_ways() {
        let rows = [
            (
                "2026-03-20T14:30:45+09:00",
                "2026-03-20T14:30:45+09:00",
                "2026-03-20T14:30:45+09:00",
            ),
            (
                "2026-03-20T14:30:45.93-05:30",
                "2026-03-20T14:30:45.930-05:30",
                "2026-03-20T14:30:45.930-05:30",
            ),
            (
                "2026-03-20T14:30:45.64627+09:00",
                "2026-03-20T14:30:45.646270+09:00",
                "2026-03-20T14:30:45.646270+09:00",
            ),
            (
                "2026-03-20T14:30:45.04989653Z",
                "2026-03-20T14:30:45.049896530+00:00",
                "2026-03-20T14:30:45.049896530Z",
            ),
            (
                "2026-03-20T14:30:45.000000001+00:00",
                "2026-03-20T14:30:45.000000001+00:00",
                "2026-03-20T14:30:45.000000001Z",
            ),
        ];
        for (written, plain, z) in rows {
            let stamp: Stamp = written.parse().unwrap();
            let utc: UtcStamp = written.parse().unwrap();

            assert_eq!(stamp.rfc3339(), plain, "{written}");
            assert_eq!(stamp.rfc3339_z(), z, "{written}");
            assert_eq!(
                utc.rfc3339(),
                utc.rfc3339_z().replace('Z', "+00:00"),
                "{written}"
            );
        }
    }

    /// An offset with seconds (a zone's local mean time, for an old date) is rounded to the
    /// minute, and `Z` is decided before the rounding. Frozen from chrono 0.4.45.
    #[test]
    fn an_offset_with_seconds_is_rounded_to_the_minute() {
        for (offset, plain, z) in [
            (
                9 * 3600 + 18 * 60 + 59,
                "1880-01-01T00:00:00+09:19",
                "1880-01-01T00:00:00+09:19",
            ),
            (
                -20,
                "1880-01-01T00:00:00-00:00",
                "1880-01-01T00:00:00-00:00",
            ),
        ] {
            let stamp = Stamp::new(1880, 1, 1, 0, 0, 0, offset).unwrap();

            assert_eq!(stamp.rfc3339(), plain, "{offset}");
            assert_eq!(stamp.rfc3339_z(), z, "{offset}");
        }
    }
}
