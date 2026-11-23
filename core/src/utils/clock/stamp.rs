use std::cmp::Ordering;
use std::fmt;
use std::hash::{Hash, Hasher};
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::civil::{Day, MAX_YEAR, MIN_YEAR, NANOS_PER_SECOND, Time, WallClock};
use super::error::ClockError;
use super::{parse, zone};

/// Whether `seconds` east of UTC is an offset at all: less than a day either way.
pub(super) const fn is_offset(seconds: i32) -> bool {
    -86_400 < seconds && seconds < 86_400
}

/// RFC 3339 as chrono's `write_rfc3339` spells it with `SecondsFormat::AutoSi`.
///
/// AIDEV-NOTE: written by hand, never by jiff's `Display`, serde or `DateTimePrinter`.
/// Those trim the fraction to its last non-zero digit (`.120` becomes `.12`), always write
/// `Z` for UTC or add a `[zone]` annotation, and a note's `time:`, a version's, the state
/// file and the Worker's `last_modified` are hashed and synced byte for byte.
fn rfc3339(wall: WallClock, offset: i32, use_z: bool) -> String {
    // AutoSi: none, or the fewest of 3, 6 and 9 digits that hold the fraction, never trimmed
    let fraction = match wall.time().shown_nanos() {
        0 => String::new(),
        nanos if nanos.is_multiple_of(1_000_000) => format!(".{:03}", nanos / 1_000_000),
        nanos if nanos.is_multiple_of(1_000) => format!(".{:06}", nanos / 1_000),
        nanos => format!(".{nanos:09}"),
    };
    // `Z` is decided on the offset as it is; the digits are rounded to the minute
    let zone = if use_z && offset == 0 {
        "Z".to_string()
    } else {
        let sign = if offset < 0 { '-' } else { '+' };
        let minutes = (offset.unsigned_abs() + 30) / 60;
        format!("{sign}{:02}:{:02}", minutes / 60, minutes % 60)
    };
    format!("{}{fraction}{zone}", wall.iso_seconds())
}

/// A `SystemTime` as chrono's `From<SystemTime>` reads it, the nanoseconds counted forward
/// from the second before even when the time is before 1970.
///
/// AIDEV-NOTE: chrono panics past its range; this clamps to the first or last instant
/// instead, so a file with an absurd mtime is still scanned. The range is chrono's, so the
/// clamp only meets times hundreds of thousands of years away.
fn wall_of_system_time(time: SystemTime) -> WallClock {
    let (seconds, nanos) = match time.duration_since(UNIX_EPOCH) {
        Ok(after) => (
            i64::try_from(after.as_secs()).unwrap_or(i64::MAX),
            after.subsec_nanos(),
        ),
        Err(e) => {
            let before = e.duration();
            let seconds = i64::try_from(before.as_secs()).unwrap_or(i64::MAX);
            match before.subsec_nanos() {
                0 => (-seconds, 0),
                nanos => (-seconds - 1, NANOS_PER_SECOND - nanos),
            }
        }
    };
    WallClock::from_unix(seconds, nanos).unwrap_or_else(|| {
        if seconds < 0 {
            first_instant()
        } else {
            last_instant()
        }
    })
}

fn first_instant() -> WallClock {
    match (Day::new(MIN_YEAR, 1, 1), Time::new(0, 0, 0)) {
        (Some(day), Some(time)) => WallClock::of(day, time),
        _ => unreachable!("the first instant of the range exists"),
    }
}

fn last_instant() -> WallClock {
    match (
        Day::new(MAX_YEAR, 12, 31),
        Time::with_nanos(23, 59, 59, 999_999_999),
    ) {
        (Some(day), Some(time)) => WallClock::of(day, time),
        _ => unreachable!("the last instant of the range exists"),
    }
}

/// An instant together with the UTC offset it was written in.
///
/// A note's `time` / `updated` and a Codex version's `time` are one. The offset decides
/// the wall clock (and so the ID and the date) a record carries, but two stamps are equal,
/// ordered and hashed by the instant alone, whatever offset each was written in.
///
/// Serialized as RFC 3339 with `Z` for a zero offset and a fraction of 0, 3, 6 or 9
/// digits; read by the relaxed RFC 3339 grammar (a space for the `T`, `+0900`, `UTC`).
#[derive(Clone, Copy)]
pub struct Stamp {
    /// The instant, as UTC's wall clock (a leap second's fraction included).
    utc: WallClock,
    /// Seconds east of UTC, less than a day either way.
    offset: i32,
}

impl Stamp {
    /// Now, in the device's offset at this instant.
    #[must_use]
    pub fn now_local() -> Self {
        Self::in_local_offset(UtcStamp::now().0)
    }

    /// A wall clock at a fixed offset (`offset_seconds` east of UTC). `None` when the date,
    /// the time or the offset does not exist.
    #[must_use]
    pub fn new(
        year: i32,
        month: u32,
        day: u32,
        hour: u32,
        minute: u32,
        second: u32,
        offset_seconds: i32,
    ) -> Option<Self> {
        if !is_offset(offset_seconds) {
            return None;
        }
        Self::from_local(
            WallClock::new(year, month, day, hour, minute, second)?,
            offset_seconds,
        )
    }

    /// The instant a wall clock names at `offset`. `None` when that instant is past the
    /// range.
    pub(super) fn from_local(wall: WallClock, offset: i32) -> Option<Self> {
        Some(Self {
            utc: wall.minus_offset(offset)?,
            offset,
        })
    }

    fn in_local_offset(utc: WallClock) -> Self {
        Self {
            utc,
            offset: zone::local_offset_at(utc),
        }
    }

    /// The same wall clock with its fraction replaced. `None` past two seconds' worth, or for
    /// a leap fraction off second 59.
    #[cfg(test)]
    pub(super) fn with_nanosecond(self, nanos: u32) -> Option<Self> {
        let wall = self.wall();
        let time = Time::with_nanos(wall.hour(), wall.minute(), wall.second(), nanos)?;
        Self::from_local(WallClock::of(wall.date(), time), self.offset)
    }

    /// A file's mtime in the device's offset at that instant.
    #[must_use]
    pub fn from_system_time_local(time: SystemTime) -> Self {
        Self::in_local_offset(wall_of_system_time(time))
    }

    /// The strict RFC 3339 grammar: fixed widths, seconds required, `T` / `t` / space, `Z` /
    /// `z` / `±HH:MM`. What a metadata edit sends and what repair counts as a `time:` line.
    pub fn parse_strict(text: &str) -> Result<Self, ClockError> {
        parse::strict(text)
    }

    /// RFC 3339 with a zero offset spelled `+00:00`: what MCP and the CLI hand out.
    #[must_use]
    pub fn rfc3339(&self) -> String {
        rfc3339(self.wall(), self.offset, false)
    }

    /// RFC 3339 with a zero offset spelled `Z`: the spelling serde writes.
    #[must_use]
    pub fn rfc3339_z(&self) -> String {
        rfc3339(self.wall(), self.offset, true)
    }

    /// The wall clock in the stamp's own offset.
    #[must_use]
    pub fn wall(&self) -> WallClock {
        self.utc.plus_offset(self.offset)
    }

    /// The date in the stamp's own offset, not UTC's or the device's.
    #[must_use]
    pub fn day(&self) -> Day {
        self.wall().date()
    }

    /// `YYYYMMDD_HHMMSS` in the stamp's own offset: a note's and a version's ID.
    #[must_use]
    pub fn id_stem(&self) -> String {
        self.wall().id_stem()
    }

    /// `YYYY-MM-DD HH:MM` in the stamp's own offset: the CLI's list.
    #[must_use]
    pub fn list_minute(&self) -> String {
        self.wall().minute_text()
    }

    /// `MM/DD` in the stamp's own offset: a widget's note row.
    #[must_use]
    pub fn month_day(&self) -> String {
        let day = self.day();
        format!("{:02}/{:02}", day.month(), day.day())
    }

    /// An exact number of seconds later (earlier when negative), the offset kept as it is.
    ///
    /// # Panics
    ///
    /// Past the last instant that can be written, as chrono's `+` did.
    #[must_use]
    pub fn plus_seconds(self, seconds: i64) -> Self {
        Self {
            utc: self.utc.plus_seconds(seconds),
            offset: self.offset,
        }
    }
}

impl PartialEq for Stamp {
    fn eq(&self, other: &Self) -> bool {
        self.utc == other.utc
    }
}

impl Eq for Stamp {}

impl PartialOrd for Stamp {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Stamp {
    fn cmp(&self, other: &Self) -> Ordering {
        self.utc.cmp(&other.utc)
    }
}

impl Hash for Stamp {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.utc.hash(state);
    }
}

impl fmt::Debug for Stamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.rfc3339())
    }
}

/// The relaxed RFC 3339 grammar, the one serde reads with.
impl FromStr for Stamp {
    type Err = ClockError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse::relaxed(text)
    }
}

impl Serialize for Stamp {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(&self.rfc3339_z())
    }
}

/// serde's side of an RFC 3339 string, with chrono's words for a value that is not one.
struct Rfc3339Visitor;

impl Visitor<'_> for Rfc3339Visitor {
    type Value = Stamp;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an RFC 3339 formatted date and time string")
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Stamp, E> {
        value.parse().map_err(E::custom)
    }
}

impl<'de> Deserialize<'de> for Stamp {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_str(Rfc3339Visitor)
    }
}

/// An instant in UTC: sync times (mtimes, the state file, the Worker's `last_modified`).
///
/// Serialized as RFC 3339 with `Z` and a fraction of 0, 3, 6 or 9 digits; read by the
/// relaxed RFC 3339 grammar, any offset turned into UTC.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct UtcStamp(WallClock);

impl UtcStamp {
    #[must_use]
    pub fn now() -> Self {
        Self::from_system_time(SystemTime::now())
    }

    /// `None` when the date or the time does not exist.
    #[must_use]
    pub const fn new(
        year: i32,
        month: u32,
        day: u32,
        hour: u32,
        minute: u32,
        second: u32,
    ) -> Option<Self> {
        match WallClock::new(year, month, day, hour, minute, second) {
            Some(wall) => Some(Self(wall)),
            None => None,
        }
    }

    /// UTC's wall clock at this instant.
    pub(super) const fn wall(self) -> WallClock {
        self.0
    }

    /// A file's mtime.
    #[must_use]
    pub fn from_system_time(time: SystemTime) -> Self {
        Self(wall_of_system_time(time))
    }

    /// RFC 3339 spelled `+00:00`: the `last_modified` the Worker stores as it arrives.
    #[must_use]
    pub fn rfc3339(&self) -> String {
        rfc3339(self.0, 0, false)
    }

    /// RFC 3339 spelled `Z`: the spelling serde writes.
    #[must_use]
    pub fn rfc3339_z(&self) -> String {
        rfc3339(self.0, 0, true)
    }

    /// `YYYYMMDD-HHMMSS` in UTC: the stamp in a conflict copy's name.
    #[must_use]
    pub fn conflict_stamp(&self) -> String {
        self.0.compact('-')
    }

    /// Whole seconds since the Unix epoch, rounded toward the past.
    #[must_use]
    pub const fn unix_seconds(&self) -> i64 {
        self.0.unix_seconds()
    }

    /// The nanoseconds past [`Self::unix_seconds`].
    #[must_use]
    pub const fn subsec_nanos(&self) -> u32 {
        self.0.time().frac()
    }

    /// Whole milliseconds since the Unix epoch, rounded toward the past (before 1970 too).
    #[must_use]
    pub const fn unix_millis(&self) -> i64 {
        self.unix_seconds() * 1000 + (self.subsec_nanos() / 1_000_000) as i64
    }

    /// An exact number of seconds later (earlier when negative).
    ///
    /// # Panics
    ///
    /// Past the last instant that can be written, as chrono's `+` did.
    #[must_use]
    pub fn plus_seconds(self, seconds: i64) -> Self {
        Self(self.0.plus_seconds(seconds))
    }
}

impl fmt::Debug for UtcStamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.rfc3339_z())
    }
}

/// The relaxed RFC 3339 grammar, any offset turned into UTC.
impl FromStr for UtcStamp {
    type Err = ClockError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse::relaxed(text).map(|at| Self(at.utc))
    }
}

impl Serialize for UtcStamp {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(&self.rfc3339_z())
    }
}

impl<'de> Deserialize<'de> for UtcStamp {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer
            .deserialize_str(Rfc3339Visitor)
            .map(|at| Self(at.utc))
    }
}

/// Whole seconds since the Unix epoch, now. What a JWT's `exp` / `iat` is compared with.
#[must_use]
pub fn unix_seconds_now() -> i64 {
    UtcStamp::now().unix_seconds()
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

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

    /// An mtime chrono could not hold (it panicked) is clamped to the end of the range it
    /// is past, so the scan still lists the file.
    #[test]
    fn a_system_time_past_the_range_is_clamped() {
        let far = Duration::from_secs(1 << 44);
        let mut got = Vec::new();
        if let Some(late) = UNIX_EPOCH.checked_add(far) {
            got.push(UtcStamp::from_system_time(late).rfc3339());
        }
        if let Some(early) = UNIX_EPOCH.checked_sub(far) {
            got.push(UtcStamp::from_system_time(early).rfc3339());
        }

        for spelled in &got {
            assert!(
                [
                    "+262142-12-31T23:59:59.999999999+00:00",
                    "-262143-01-01T00:00:00+00:00"
                ]
                .contains(&spelled.as_str()),
                "{spelled}"
            );
        }
    }

    /// A year past `i32` is past the range, not the year inside it that it wraps to (1930).
    #[test]
    fn a_system_time_whose_year_wraps_past_i32_is_clamped() {
        let wrapped_2026 = Day::new(2026, 1, 1).unwrap().days() + (1 << 32) / 400 * 146_097;
        let far = u64::try_from(wrapped_2026 * 86_400).unwrap();
        let Some(late) = UNIX_EPOCH.checked_add(Duration::from_secs(far)) else {
            return;
        };

        assert_eq!(
            UtcStamp::from_system_time(late).rfc3339(),
            "+262142-12-31T23:59:59.999999999+00:00"
        );
        assert_eq!(WallClock::from_unix(i64::try_from(far).unwrap(), 0), None);
    }
}
