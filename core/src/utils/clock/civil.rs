use std::fmt;
use std::str::FromStr;

use chrono::{Datelike as _, Local, NaiveDate, NaiveDateTime, NaiveTime, TimeDelta, Timelike as _};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::error::ClockError;

const DAY_FORMAT: &str = "%Y-%m-%d";
const ID_STEM_FORMAT: &str = "%Y%m%d_%H%M%S";
const HMS_FORMAT: &str = "%H:%M:%S";

/// A calendar date with no zone: a Scrawl day, a search period's end, the date a record
/// is filed under.
///
/// `Display` and serde spell it `YYYY-MM-DD`; serde reads it with the date type's own
/// lenient grammar, [`Self::parse_ymd`] with `%Y-%m-%d`'s.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Day(NaiveDate);

impl Day {
    /// `None` when the date does not exist.
    #[must_use]
    pub const fn new(year: i32, month: u32, day: u32) -> Option<Self> {
        match NaiveDate::from_ymd_opt(year, month, day) {
            Some(date) => Some(Self(date)),
            None => None,
        }
    }

    pub(super) const fn from_inner(inner: NaiveDate) -> Self {
        Self(inner)
    }

    /// Today on the device's wall clock.
    #[must_use]
    pub fn today_local() -> Self {
        Self(Local::now().date_naive())
    }

    /// `%Y-%m-%d` as typed by a person or found in a file name: an argument to the CLI,
    /// MCP or IPC, a day file's stem.
    pub fn parse_ymd(text: &str) -> Result<Self, ClockError> {
        NaiveDate::parse_from_str(text, DAY_FORMAT)
            .map(Self)
            .map_err(ClockError)
    }

    /// `YYYY-MM-DD`: a day file's stem, and the date handed to the screen and MCP.
    #[must_use]
    pub fn ymd(&self) -> String {
        self.0.format(DAY_FORMAT).to_string()
    }

    #[must_use]
    pub fn year(&self) -> i32 {
        self.0.year()
    }

    #[must_use]
    pub fn month(&self) -> u32 {
        self.0.month()
    }

    #[must_use]
    pub fn day(&self) -> u32 {
        self.0.day()
    }

    /// `days` calendar days later (earlier when negative). `None` out of range.
    #[must_use]
    pub fn plus_days(self, days: i64) -> Option<Self> {
        self.0
            .checked_add_signed(TimeDelta::try_days(days)?)
            .map(Self)
    }
}

impl fmt::Debug for Day {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.0, f)
    }
}

impl fmt::Display for Day {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, f)
    }
}

/// The date type's own grammar, the one serde reads with: laxer than `%Y-%m-%d` about
/// spaces around the fields.
impl FromStr for Day {
    type Err = ClockError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        text.parse().map(Self).map_err(ClockError)
    }
}

impl Serialize for Day {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for Day {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        NaiveDate::deserialize(deserializer).map(Self)
    }
}

/// A time of day with no date and no zone: the `[HH:MM:SS]` of a Scrawl line.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Time(NaiveTime);

impl Time {
    /// `None` when the time does not exist.
    #[must_use]
    pub const fn new(hour: u32, minute: u32, second: u32) -> Option<Self> {
        match NaiveTime::from_hms_opt(hour, minute, second) {
            Some(time) => Some(Self(time)),
            None => None,
        }
    }

    /// `%H:%M:%S`, a Scrawl line's time.
    pub fn parse_hms(text: &str) -> Result<Self, ClockError> {
        NaiveTime::parse_from_str(text, HMS_FORMAT)
            .map(Self)
            .map_err(ClockError)
    }

    /// `HH:MM:SS`: a Scrawl line's time, and the one MCP hands out.
    #[must_use]
    pub fn hms(&self) -> String {
        self.0.format(HMS_FORMAT).to_string()
    }

    /// `HH:MM`: the CLI's `scrawl show`.
    #[must_use]
    pub fn hm(&self) -> String {
        self.0.format("%H:%M").to_string()
    }
}

impl fmt::Debug for Time {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.0, f)
    }
}

/// A date and a time of day with no zone: what the device's clock reads, or what a
/// note's ID spells.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct WallClock(NaiveDateTime);

impl WallClock {
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
        NaiveDate::from_ymd_opt(year, month, day)?
            .and_hms_opt(hour, minute, second)
            .map(Self)
    }

    pub(super) const fn from_inner(inner: NaiveDateTime) -> Self {
        Self(inner)
    }

    pub(super) const fn inner(&self) -> NaiveDateTime {
        self.0
    }

    /// The device's wall clock now.
    #[must_use]
    pub fn now_local() -> Self {
        Self(Local::now().naive_local())
    }

    /// `YYYYMMDD_HHMMSS`, the stem of a note's, a version's or a snapshot's ID.
    pub fn parse_id_stem(text: &str) -> Result<Self, ClockError> {
        NaiveDateTime::parse_from_str(text, ID_STEM_FORMAT)
            .map(Self)
            .map_err(ClockError)
    }

    /// `YYYYMMDD_HHMMSS`: the stem of a note's, a version's or a snapshot's ID.
    #[must_use]
    pub fn id_stem(&self) -> String {
        self.0.format(ID_STEM_FORMAT).to_string()
    }

    #[must_use]
    pub const fn date(&self) -> Day {
        Day(self.0.date())
    }

    #[must_use]
    pub const fn time(&self) -> Time {
        Time(self.0.time())
    }

    #[must_use]
    pub fn year(&self) -> i32 {
        self.0.year()
    }

    #[must_use]
    pub fn month(&self) -> u32 {
        self.0.month()
    }

    #[must_use]
    pub fn day(&self) -> u32 {
        self.0.day()
    }

    #[must_use]
    pub fn hour(&self) -> u32 {
        self.0.hour()
    }

    #[must_use]
    pub fn minute(&self) -> u32 {
        self.0.minute()
    }

    /// 0 to 59; a leap second reads as 59.
    #[must_use]
    pub fn second(&self) -> u32 {
        self.0.second()
    }

    /// 0 for Sunday through 6 for Saturday.
    #[must_use]
    pub fn weekday_from_sunday(&self) -> u32 {
        self.0.weekday().num_days_from_sunday()
    }

    /// An exact number of seconds later (earlier when negative).
    #[must_use]
    pub fn plus_seconds(self, seconds: i64) -> Self {
        Self(self.0 + TimeDelta::seconds(seconds))
    }
}

impl fmt::Debug for WallClock {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.0, f)
    }
}
