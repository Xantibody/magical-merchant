use std::fmt;
use std::str::FromStr;
use std::time::SystemTime;

use chrono::{DateTime, FixedOffset, Local, SecondsFormat, TimeDelta, TimeZone as _, Utc};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::civil::{Day, WallClock};
use super::error::ClockError;

/// An instant together with the UTC offset it was written in.
///
/// A note's `time` / `updated` and a Codex version's `time` are one. The offset decides
/// the wall clock (and so the ID and the date) a record carries, but two stamps are equal,
/// ordered and hashed by the instant alone, whatever offset each was written in.
///
/// Serialized as RFC 3339 with `Z` for a zero offset and a fraction of 0, 3, 6 or 9
/// digits; read by the relaxed RFC 3339 grammar (a space for the `T`, `+0900`, `UTC`).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Stamp(DateTime<FixedOffset>);

impl Stamp {
    /// Now, in the device's offset at this instant.
    #[must_use]
    pub fn now_local() -> Self {
        Self(Local::now().fixed_offset())
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
        FixedOffset::east_opt(offset_seconds)?
            .with_ymd_and_hms(year, month, day, hour, minute, second)
            .single()
            .map(Self)
    }

    pub(super) const fn from_inner(inner: DateTime<FixedOffset>) -> Self {
        Self(inner)
    }

    /// The same wall clock with its fraction replaced. `None` past two seconds' worth, or for
    /// a leap fraction off second 59.
    #[cfg(test)]
    pub(super) fn with_nanosecond(self, nanos: u32) -> Option<Self> {
        chrono::Timelike::with_nanosecond(&self.0, nanos).map(Self)
    }

    /// A file's mtime in the device's offset at that instant.
    ///
    /// AIDEV-NOTE: infallible like chrono's `From<SystemTime>`, which panics outside its
    /// range; a backend with a narrower range clamps here, so callers keep this signature.
    #[must_use]
    pub fn from_system_time_local(time: SystemTime) -> Self {
        Self(DateTime::<Local>::from(time).fixed_offset())
    }

    /// The strict RFC 3339 grammar: fixed widths, seconds required, `T` / `t` / space, `Z` /
    /// `z` / `±HH:MM`. What a metadata edit sends and what repair counts as a `time:` line.
    pub fn parse_strict(text: &str) -> Result<Self, ClockError> {
        DateTime::parse_from_rfc3339(text)
            .map(Self)
            .map_err(ClockError)
    }

    /// RFC 3339 with a zero offset spelled `+00:00`: what MCP and the CLI hand out.
    #[must_use]
    pub fn rfc3339(&self) -> String {
        self.0.to_rfc3339()
    }

    /// RFC 3339 with a zero offset spelled `Z`: the spelling serde writes.
    #[must_use]
    pub fn rfc3339_z(&self) -> String {
        self.0.to_rfc3339_opts(SecondsFormat::AutoSi, true)
    }

    /// The wall clock in the stamp's own offset.
    #[must_use]
    pub fn wall(&self) -> WallClock {
        WallClock::from_inner(self.0.naive_local())
    }

    /// The date in the stamp's own offset, not UTC's or the device's.
    #[must_use]
    pub fn day(&self) -> Day {
        Day::from_inner(self.0.date_naive())
    }

    /// `YYYYMMDD_HHMMSS` in the stamp's own offset: a note's and a version's ID.
    #[must_use]
    pub fn id_stem(&self) -> String {
        self.wall().id_stem()
    }

    /// `YYYY-MM-DD HH:MM` in the stamp's own offset: the CLI's list.
    #[must_use]
    pub fn list_minute(&self) -> String {
        self.0.format("%Y-%m-%d %H:%M").to_string()
    }

    /// `MM/DD` in the stamp's own offset: a widget's note row.
    #[must_use]
    pub fn month_day(&self) -> String {
        self.0.format("%m/%d").to_string()
    }

    /// An exact number of seconds later (earlier when negative), the offset kept as it is.
    #[must_use]
    pub fn plus_seconds(self, seconds: i64) -> Self {
        Self(self.0 + TimeDelta::seconds(seconds))
    }
}

impl fmt::Debug for Stamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.0, f)
    }
}

/// The relaxed RFC 3339 grammar, the one serde reads with.
impl FromStr for Stamp {
    type Err = ClockError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        text.parse().map(Self).map_err(ClockError)
    }
}

impl Serialize for Stamp {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for Stamp {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        DateTime::<FixedOffset>::deserialize(deserializer).map(Self)
    }
}

/// An instant in UTC: sync times (mtimes, the state file, the Worker's `last_modified`).
///
/// Serialized as RFC 3339 with `Z` and a fraction of 0, 3, 6 or 9 digits; read by the
/// relaxed RFC 3339 grammar, any offset turned into UTC.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct UtcStamp(DateTime<Utc>);

impl UtcStamp {
    #[must_use]
    pub fn now() -> Self {
        Self(Utc::now())
    }

    /// `None` when the date or the time does not exist.
    #[must_use]
    pub fn new(
        year: i32,
        month: u32,
        day: u32,
        hour: u32,
        minute: u32,
        second: u32,
    ) -> Option<Self> {
        Utc.with_ymd_and_hms(year, month, day, hour, minute, second)
            .single()
            .map(Self)
    }

    /// A file's mtime.
    ///
    /// AIDEV-NOTE: infallible like chrono's `From<SystemTime>`, which panics outside its
    /// range; a backend with a narrower range clamps here, so the scan keeps this signature.
    #[must_use]
    pub fn from_system_time(time: SystemTime) -> Self {
        Self(time.into())
    }

    /// RFC 3339 spelled `+00:00`: the `last_modified` the Worker stores as it arrives.
    #[must_use]
    pub fn rfc3339(&self) -> String {
        self.0.to_rfc3339()
    }

    /// RFC 3339 spelled `Z`: the spelling serde writes.
    #[must_use]
    pub fn rfc3339_z(&self) -> String {
        self.0.to_rfc3339_opts(SecondsFormat::AutoSi, true)
    }

    /// `YYYYMMDD-HHMMSS` in UTC: the stamp in a conflict copy's name.
    #[must_use]
    pub fn conflict_stamp(&self) -> String {
        self.0.format("%Y%m%d-%H%M%S").to_string()
    }

    /// Whole seconds since the Unix epoch, rounded toward the past.
    #[must_use]
    pub const fn unix_seconds(&self) -> i64 {
        self.0.timestamp()
    }

    /// The nanoseconds past [`Self::unix_seconds`].
    #[must_use]
    pub const fn subsec_nanos(&self) -> u32 {
        self.0.timestamp_subsec_nanos()
    }

    /// Whole milliseconds since the Unix epoch, rounded toward the past (before 1970 too).
    #[must_use]
    pub const fn unix_millis(&self) -> i64 {
        self.0.timestamp_millis()
    }

    /// An exact number of seconds later (earlier when negative).
    #[must_use]
    pub fn plus_seconds(self, seconds: i64) -> Self {
        Self(self.0 + TimeDelta::seconds(seconds))
    }
}

impl fmt::Debug for UtcStamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.0, f)
    }
}

/// The relaxed RFC 3339 grammar, any offset turned into UTC.
impl FromStr for UtcStamp {
    type Err = ClockError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        text.parse().map(Self).map_err(ClockError)
    }
}

impl Serialize for UtcStamp {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for UtcStamp {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        DateTime::<Utc>::deserialize(deserializer).map(Self)
    }
}
