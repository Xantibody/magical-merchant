use std::fmt;
use std::str::FromStr;

use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::error::ClockError;
use super::{parse, zone};

/// The first and last year a date may carry: chrono's range, so that every date chrono read
/// (a signed `+10000`, a `-0001`) still reads, and one past it still does not.
pub(super) const MIN_YEAR: i32 = (i32::MIN >> 13) + 1;
pub(super) const MAX_YEAR: i32 = (i32::MAX >> 13) - 1;

pub(super) const SECONDS_PER_DAY: i64 = 86_400;
pub(super) const NANOS_PER_SECOND: u32 = 1_000_000_000;

/// `1970-01-01` as days from `0000-03-01`, the origin of [`days_from_civil`].
const UNIX_EPOCH_DAYS: i64 = 719_468;

const fn is_leap_year(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

const fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        2 if is_leap_year(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's `days_from_civil`).
const fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_from_march = (month as i64 + 9) % 12;
    let day_of_year = (153 * month_from_march + 2) / 5 + day as i64 - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - UNIX_EPOCH_DAYS
}

/// The inverse of [`days_from_civil`]: (year, month, day). The year stays an `i64`: days
/// counted from an mtime can name one past `i32`, and only the caller knows its range.
// The algorithm keeps the month in 1..=12 and the day in 1..=31, so they fit
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
const fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let days = days + UNIX_EPOCH_DAYS;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_from_march = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_from_march + 2) / 5 + 1;
    let month = if month_from_march < 10 {
        month_from_march + 3
    } else {
        month_from_march - 9
    };
    let year = year_of_era + era * 400 + if month <= 2 { 1 } else { 0 };
    (year, month as u32, day as u32)
}

/// A year as chrono spells it everywhere: four digits for 0 to 9999, otherwise signed.
pub(super) fn year_text(year: i32) -> String {
    if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+05}")
    }
}

/// A calendar date with no zone: a Scrawl day, a search period's end, the date a record
/// is filed under.
///
/// `Display` and serde spell it `YYYY-MM-DD`; serde reads it with the date type's own
/// lenient grammar, [`Self::parse_ymd`] with `%Y-%m-%d`'s.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Day {
    year: i32,
    month: u32,
    /// The day of the month.
    mday: u32,
}

impl Day {
    /// `None` when the date does not exist.
    #[must_use]
    pub const fn new(year: i32, month: u32, day: u32) -> Option<Self> {
        if year < MIN_YEAR
            || year > MAX_YEAR
            || month < 1
            || month > 12
            || day < 1
            || day > days_in_month(year as i64, month)
        {
            return None;
        }
        Some(Self {
            year,
            month,
            mday: day,
        })
    }

    /// The date `days` after 1970-01-01, whatever the year: an offset may carry a wall clock
    /// one day past the last date that can be written, as chrono's could.
    pub(super) const fn from_days_unchecked(days: i64) -> Self {
        let (year, month, mday) = civil_from_days(days);
        // A day from a date in the range, a day either way at most, so the year fits
        #[allow(clippy::cast_possible_truncation)]
        let year = year as i32;
        Self { year, month, mday }
    }

    /// The date `days` after 1970-01-01. `None` past the range.
    pub(super) const fn from_days(days: i64) -> Option<Self> {
        let (year, month, mday) = civil_from_days(days);
        if year < MIN_YEAR as i64 || year > MAX_YEAR as i64 {
            return None;
        }
        // Checked against the range just above
        #[allow(clippy::cast_possible_truncation)]
        let year = year as i32;
        Some(Self { year, month, mday })
    }

    /// Days since 1970-01-01.
    pub(super) const fn days(self) -> i64 {
        days_from_civil(self.year as i64, self.month, self.mday)
    }

    /// Today on the device's wall clock.
    #[must_use]
    pub fn today_local() -> Self {
        WallClock::now_local().date()
    }

    /// `%Y-%m-%d` as typed by a person or found in a file name: an argument to the CLI,
    /// MCP or IPC, a day file's stem.
    pub fn parse_ymd(text: &str) -> Result<Self, ClockError> {
        parse::ymd(text)
    }

    /// `YYYY-MM-DD`: a day file's stem, and the date handed to the screen and MCP.
    #[must_use]
    pub fn ymd(&self) -> String {
        format!(
            "{}-{:02}-{:02}",
            year_text(self.year),
            self.month,
            self.mday
        )
    }

    #[must_use]
    pub const fn year(&self) -> i32 {
        self.year
    }

    #[must_use]
    pub const fn month(&self) -> u32 {
        self.month
    }

    #[must_use]
    pub const fn day(&self) -> u32 {
        self.mday
    }

    /// `days` calendar days later (earlier when negative). `None` out of range.
    #[must_use]
    pub fn plus_days(self, days: i64) -> Option<Self> {
        // chrono refuses a step past an `i32` of days before it looks at the result
        let days = i32::try_from(days).ok()?;
        Self::from_days(self.days() + i64::from(days))
    }

    /// 0 for Sunday through 6 for Saturday.
    const fn weekday_from_sunday(self) -> u32 {
        // 1970-01-01 was a Thursday; the remainder is in 0..7
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let weekday = (self.days() + 4).rem_euclid(7) as u32;
        weekday
    }
}

impl fmt::Debug for Day {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.ymd())
    }
}

impl fmt::Display for Day {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.ymd())
    }
}

/// The date type's own grammar, the one serde reads with: laxer than `%Y-%m-%d` about
/// spaces around the fields.
impl FromStr for Day {
    type Err = ClockError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse::day(text)
    }
}

impl Serialize for Day {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Day {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct DayVisitor;

        impl Visitor<'_> for DayVisitor {
            type Value = Day;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a formatted date string")
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<Day, E> {
                value.parse().map_err(E::custom)
            }
        }

        deserializer.deserialize_str(DayVisitor)
    }
}

/// A time of day with no date and no zone: the `[HH:MM:SS]` of a Scrawl line.
///
/// AIDEV-NOTE: a leap second is kept as chrono kept it, second 59 with a fraction of one
/// second or more, so `23:59:60` reads and prints back as itself. jiff's civil time cannot
/// hold it (it clamps `:60` to `:59`), and a Scrawl line or an ID stem that spells one
/// already reads; the alternative, clamping here, would rewrite those times.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Time {
    /// Seconds since midnight.
    secs: u32,
    /// Nanoseconds past `secs`. A leap second, and nothing else, carries a whole second here.
    frac: u32,
}

impl Time {
    /// `None` when the time does not exist.
    #[must_use]
    pub const fn new(hour: u32, minute: u32, second: u32) -> Option<Self> {
        Self::with_nanos(hour, minute, second, 0)
    }

    /// chrono's `from_hms_nano_opt`: a whole second of fraction is a leap second, so it is
    /// allowed on second 59 alone.
    pub(super) const fn with_nanos(
        hour: u32,
        minute: u32,
        second: u32,
        nanos: u32,
    ) -> Option<Self> {
        if hour >= 24
            || minute >= 60
            || second >= 60
            || (nanos >= NANOS_PER_SECOND && second != 59)
            || nanos >= 2 * NANOS_PER_SECOND
        {
            return None;
        }
        Some(Self {
            secs: hour * 3600 + minute * 60 + second,
            frac: nanos,
        })
    }

    /// `%H:%M:%S`, a Scrawl line's time.
    pub fn parse_hms(text: &str) -> Result<Self, ClockError> {
        parse::hms(text)
    }

    pub(super) const fn frac(self) -> u32 {
        self.frac
    }

    const fn hour(self) -> u32 {
        self.secs / 3600
    }

    const fn minute(self) -> u32 {
        self.secs / 60 % 60
    }

    /// The second as written: 60 during a leap second.
    const fn shown_second(self) -> u32 {
        self.secs % 60 + self.frac / NANOS_PER_SECOND
    }

    /// The fraction as written: what is left past the second shown.
    pub(super) const fn shown_nanos(self) -> u32 {
        self.frac % NANOS_PER_SECOND
    }

    /// `HH:MM:SS`: a Scrawl line's time, and the one MCP hands out.
    #[must_use]
    pub fn hms(&self) -> String {
        format!(
            "{:02}:{:02}:{:02}",
            self.hour(),
            self.minute(),
            self.shown_second()
        )
    }

    /// `HH:MM`: the CLI's `scrawl show`.
    #[must_use]
    pub fn hm(&self) -> String {
        format!("{:02}:{:02}", self.hour(), self.minute())
    }
}

impl fmt::Debug for Time {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.hms())?;
        match self.shown_nanos() {
            0 => Ok(()),
            nanos => write!(f, ".{nanos:09}"),
        }
    }
}

/// A date and a time of day with no zone: what the device's clock reads, or what a
/// note's ID spells.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct WallClock {
    date: Day,
    time: Time,
}

impl WallClock {
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
        match (Day::new(year, month, day), Time::new(hour, minute, second)) {
            (Some(date), Some(time)) => Some(Self { date, time }),
            _ => None,
        }
    }

    pub(super) const fn of(date: Day, time: Time) -> Self {
        Self { date, time }
    }

    /// `seconds` and `nanos` past the Unix epoch. `None` past the range.
    pub(super) const fn from_unix(seconds: i64, nanos: u32) -> Option<Self> {
        let Some(date) = Day::from_days(seconds.div_euclid(SECONDS_PER_DAY)) else {
            return None;
        };
        // In 0..86_400, so it fits
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let secs = seconds.rem_euclid(SECONDS_PER_DAY) as u32;
        Some(Self {
            date,
            time: Time { secs, frac: nanos },
        })
    }

    /// Whole seconds since the Unix epoch; a leap second counts as its second 59.
    pub(super) const fn unix_seconds(self) -> i64 {
        self.date.days() * SECONDS_PER_DAY + self.time.secs as i64
    }

    /// The device's wall clock now.
    #[must_use]
    pub fn now_local() -> Self {
        let utc = super::UtcStamp::now().wall();
        utc.plus_offset(zone::local_offset_at(utc))
    }

    /// `YYYYMMDD_HHMMSS`, the stem of a note's, a version's or a snapshot's ID.
    pub fn parse_id_stem(text: &str) -> Result<Self, ClockError> {
        parse::id_stem(text)
    }

    /// `YYYYMMDD_HHMMSS`: the stem of a note's, a version's or a snapshot's ID.
    #[must_use]
    pub fn id_stem(&self) -> String {
        self.compact('_')
    }

    /// `YYYYMMDD<separator>HHMMSS`.
    pub(super) fn compact(&self, separator: char) -> String {
        format!(
            "{}{:02}{:02}{separator}{:02}{:02}{:02}",
            year_text(self.date.year),
            self.date.month,
            self.date.mday,
            self.time.hour(),
            self.time.minute(),
            self.time.shown_second()
        )
    }

    /// `YYYY-MM-DDTHH:MM:SS`, no fraction and no offset.
    pub(super) fn iso_seconds(&self) -> String {
        format!("{}T{}", self.date.ymd(), self.time.hms())
    }

    /// `YYYY-MM-DD HH:MM`.
    pub(super) fn minute_text(&self) -> String {
        format!("{} {}", self.date.ymd(), self.time.hm())
    }

    #[must_use]
    pub const fn date(&self) -> Day {
        self.date
    }

    #[must_use]
    pub const fn time(&self) -> Time {
        self.time
    }

    #[must_use]
    pub const fn year(&self) -> i32 {
        self.date.year
    }

    #[must_use]
    pub const fn month(&self) -> u32 {
        self.date.month
    }

    #[must_use]
    pub const fn day(&self) -> u32 {
        self.date.mday
    }

    #[must_use]
    pub const fn hour(&self) -> u32 {
        self.time.hour()
    }

    #[must_use]
    pub const fn minute(&self) -> u32 {
        self.time.minute()
    }

    /// 0 to 59; a leap second reads as 59.
    #[must_use]
    pub const fn second(&self) -> u32 {
        self.time.secs % 60
    }

    /// 0 for Sunday through 6 for Saturday.
    #[must_use]
    pub const fn weekday_from_sunday(&self) -> u32 {
        self.date.weekday_from_sunday()
    }

    /// An exact number of seconds later (earlier when negative).
    ///
    /// # Panics
    ///
    /// Past the last date that can be written, as chrono's `+` did.
    #[must_use]
    pub fn plus_seconds(self, seconds: i64) -> Self {
        self.checked_plus_seconds(seconds)
            .unwrap_or_else(|| panic!("`NaiveDateTime + TimeDelta` overflowed"))
    }

    /// chrono's `checked_add_signed` for whole seconds. Leaving a leap second lands on the
    /// same fraction of the next second; a step of zero stays in it.
    pub(super) fn checked_plus_seconds(self, seconds: i64) -> Option<Self> {
        let mut secs = i64::from(self.time.secs);
        let mut frac = self.time.frac;
        if frac >= NANOS_PER_SECOND {
            match seconds.signum() {
                0 => return Some(self),
                1 => frac -= NANOS_PER_SECOND,
                _ => {
                    frac -= NANOS_PER_SECOND;
                    secs += 1;
                }
            }
        }
        let secs = secs.checked_add(seconds)?;
        let in_day = secs.rem_euclid(SECONDS_PER_DAY);
        let date = Day::from_days(
            self.date
                .days()
                .checked_add((secs - in_day) / SECONDS_PER_DAY)?,
        )?;
        Some(Self {
            date,
            time: Time {
                secs: u32::try_from(in_day).ok()?,
                frac,
            },
        })
    }

    /// The wall clock `offset` seconds east of this one, the fraction (a leap second's too)
    /// kept. May land one day past the range, as chrono's `naive_local` may.
    pub(super) fn plus_offset(self, offset: i32) -> Self {
        let (time, days) = self.time.shifted(offset);
        Self {
            date: Day::from_days_unchecked(self.date.days() + days),
            time,
        }
    }

    /// The wall clock `offset` seconds west of this one, the fraction kept. `None` past the
    /// range, as chrono's `checked_sub_offset`.
    pub(super) fn minus_offset(self, offset: i32) -> Option<Self> {
        let (time, days) = self.time.shifted(-offset);
        Some(Self {
            date: Day::from_days(self.date.days() + days)?,
            time,
        })
    }
}

impl Time {
    /// The time `offset` seconds later and the days that crossed, the fraction kept.
    fn shifted(self, offset: i32) -> (Self, i64) {
        let secs = i64::from(self.secs) + i64::from(offset);
        let in_day = secs.rem_euclid(SECONDS_PER_DAY);
        // In 0..86_400, so it fits
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let time = Self {
            secs: in_day as u32,
            frac: self.frac,
        };
        (time, (secs - in_day) / SECONDS_PER_DAY)
    }
}

impl fmt::Debug for WallClock {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}T{:?}", self.date, self.time)
    }
}
