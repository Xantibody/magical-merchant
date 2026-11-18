//! A port of the parts of chrono 0.4.45's parser the app reads with: the relaxed RFC 3339
//! grammar (`FromStr` and serde of `DateTime`), the strict one (`parse_from_rfc3339`), and
//! the item parser behind `NaiveDate`'s `FromStr` and the `%Y-%m-%d`, `%H:%M:%S` and
//! `%Y%m%d_%H%M%S` patterns of `parse_from_str`.
//!
//! AIDEV-NOTE: ported, not written against jiff's parsers. Files on disk, the Worker's state
//! and what a person types were all read by chrono; jiff's strptime and RFC 3339 parser
//! accept a different set (no `UTC`, no `+0900`, no unpadded fields, no leap second) and say
//! different words when they refuse, and those words reach the screen and MCP. Each
//! function below keeps chrono's name and the order in which it gives up.

use super::civil::{Day, NANOS_PER_SECOND, Time, WallClock};
use super::error::{ClockError, Kind};
use super::stamp::{Stamp, is_offset};

type Scan<'a, T> = Result<(&'a str, T), Kind>;

// ──────────── scan.rs ────────────

/// `scan::number`: `min` to `max` ASCII digits; past `max` the rest is left unread.
fn number(s: &str, min: usize, max: usize) -> Scan<'_, i64> {
    let bytes = s.as_bytes();
    if bytes.len() < min {
        return Err(Kind::TooShort);
    }
    let mut n = 0_i64;
    for (i, &c) in bytes.iter().take(max).enumerate() {
        if !c.is_ascii_digit() {
            return if i < min {
                Err(Kind::Invalid)
            } else {
                Ok((&s[i..], n))
            };
        }
        n = n
            .checked_mul(10)
            .and_then(|n| n.checked_add(i64::from(c - b'0')))
            .ok_or(Kind::OutOfRange)?;
    }
    Ok((&s[max.min(bytes.len())..], n))
}

/// `scan::nanosecond`: one to nine digits scaled to nanoseconds; digits past the ninth are
/// skipped, not rounded.
fn nanosecond(s: &str) -> Scan<'_, u32> {
    const SCALE: [u32; 10] = [
        0,
        100_000_000,
        10_000_000,
        1_000_000,
        100_000,
        10_000,
        1_000,
        100,
        10,
        1,
    ];
    let before = s.len();
    let (s, value) = number(s, 1, 9)?;
    let value = u32::try_from(value).map_err(|_| Kind::OutOfRange)?;
    let value = value
        .checked_mul(SCALE[before - s.len()])
        .ok_or(Kind::OutOfRange)?;
    Ok((s.trim_start_matches(|c: char| c.is_ascii_digit()), value))
}

/// `scan::char`.
fn char(s: &str, expected: u8) -> Result<&str, Kind> {
    match s.as_bytes().first() {
        Some(&c) if c == expected => Ok(&s[1..]),
        Some(_) => Err(Kind::Invalid),
        None => Err(Kind::TooShort),
    }
}

/// What may stand between an offset's hours and minutes.
#[derive(Clone, Copy)]
enum Colon {
    /// Exactly one `:` (the strict grammar).
    One,
    /// Any run of `:` and whitespace, none included (the relaxed one).
    AnyOrSpace,
}

impl Colon {
    fn consume(self, s: &str) -> Result<&str, Kind> {
        match self {
            Self::One => char(s, b':'),
            Self::AnyOrSpace => Ok(s.trim_start_matches(|c: char| c == ':' || c.is_whitespace())),
        }
    }
}

/// `scan::timezone_offset` with `allow_zulu` and `allow_tz_minus_sign` on and missing
/// minutes refused, the only way the app's grammars call it.
fn timezone_offset(mut s: &str, colon: Colon) -> Scan<'_, i32> {
    if let Some(b'Z' | b'z') = s.as_bytes().first() {
        return Ok((&s[1..], 0));
    }
    let negative = match s.chars().next() {
        Some(sign @ '+') => {
            s = &s[sign.len_utf8()..];
            false
        }
        // a hyphen, or the minus sign RFC 3339 inherits from ISO 8601
        Some(sign @ ('-' | '\u{2212}')) => {
            s = &s[sign.len_utf8()..];
            true
        }
        Some(_) => return Err(Kind::Invalid),
        None => return Err(Kind::TooShort),
    };
    let digits = |s: &str| -> Result<(u8, u8), Kind> {
        match s.as_bytes() {
            [a, b, ..] => Ok((*a, *b)),
            _ => Err(Kind::TooShort),
        }
    };
    let hours = match digits(s)? {
        (h1 @ b'0'..=b'9', h2 @ b'0'..=b'9') => i32::from((h1 - b'0') * 10 + (h2 - b'0')),
        _ => return Err(Kind::Invalid),
    };
    s = colon.consume(&s[2..])?;
    let minutes = match digits(s)? {
        (m1 @ b'0'..=b'5', m2 @ b'0'..=b'9') => i32::from((m1 - b'0') * 10 + (m2 - b'0')),
        (b'6'..=b'9', b'0'..=b'9') => return Err(Kind::OutOfRange),
        _ => return Err(Kind::Invalid),
    };
    let seconds = hours * 3600 + minutes * 60;
    Ok((&s[2..], if negative { -seconds } else { seconds }))
}

// ──────────── parsed.rs ────────────

/// The fields read so far, chrono's `Parsed` cut down to the ones these grammars set.
#[derive(Default)]
struct Parsed {
    year: Option<i32>,
    month: Option<u32>,
    day: Option<u32>,
    hour: Option<u32>,
    minute: Option<u32>,
    second: Option<u32>,
    nanosecond: Option<u32>,
    offset: Option<i32>,
}

/// A field set twice must agree with itself.
fn set_if_consistent<T: PartialEq>(old: &mut Option<T>, new: T) -> Result<(), Kind> {
    match old {
        Some(old) if *old != new => Err(Kind::Impossible),
        _ => {
            *old = Some(new);
            Ok(())
        }
    }
}

/// `value` when it lies in `range`, else `OutOfRange`.
fn within(value: i64, range: std::ops::RangeInclusive<u32>) -> Result<u32, Kind> {
    u32::try_from(value)
        .ok()
        .filter(|v| range.contains(v))
        .ok_or(Kind::OutOfRange)
}

impl Parsed {
    fn set(&mut self, field: Field, value: i64) -> Result<(), Kind> {
        match field {
            Field::Year => set_if_consistent(
                &mut self.year,
                i32::try_from(value).map_err(|_| Kind::OutOfRange)?,
            ),
            Field::Month => set_if_consistent(&mut self.month, within(value, 1..=12)?),
            Field::Day => set_if_consistent(&mut self.day, within(value, 1..=31)?),
            Field::Hour => set_if_consistent(&mut self.hour, within(value, 0..=23)?),
            Field::Minute => set_if_consistent(&mut self.minute, within(value, 0..=59)?),
            Field::Second => set_if_consistent(&mut self.second, within(value, 0..=60)?),
        }
    }

    /// `Parsed::to_naive_date` for a year, a month and a day.
    fn to_date(&self) -> Result<Day, Kind> {
        match (self.year, self.month, self.day) {
            (Some(year), Some(month), Some(day)) => {
                Day::new(year, month, day).ok_or(Kind::OutOfRange)
            }
            _ => Err(Kind::NotEnough),
        }
    }

    /// `Parsed::to_naive_time`: second 60 is a leap second, kept as second 59 and one more
    /// second of fraction.
    fn to_time(&self) -> Result<Time, Kind> {
        let hour = self.hour.ok_or(Kind::NotEnough)?;
        let minute = self.minute.ok_or(Kind::NotEnough)?;
        let (second, mut nanos) = match self.second.unwrap_or(0) {
            v @ 0..=59 => (v, 0),
            60 => (59, NANOS_PER_SECOND),
            _ => return Err(Kind::OutOfRange),
        };
        nanos += match self.nanosecond {
            Some(v) if self.second.is_some() => v,
            Some(_) => return Err(Kind::NotEnough),
            None => 0,
        };
        Time::with_nanos(hour, minute, second, nanos).ok_or(Kind::OutOfRange)
    }

    /// `Parsed::to_naive_datetime_with_offset` without a timestamp field: the date's error
    /// first, then the time's.
    fn to_wall(&self) -> Result<WallClock, Kind> {
        let date = self.to_date();
        let time = self.to_time();
        Ok(WallClock::of(date?, time?))
    }

    /// `Parsed::to_datetime` with an offset field.
    fn to_stamp(&self) -> Result<Stamp, Kind> {
        let offset = self.offset.ok_or(Kind::NotEnough)?;
        let wall = self.to_wall()?;
        if !is_offset(offset) {
            return Err(Kind::OutOfRange);
        }
        Stamp::from_local(wall, offset).ok_or(Kind::Impossible)
    }
}

// ──────────── parse.rs ────────────

#[derive(Clone, Copy)]
enum Field {
    Year,
    Month,
    Day,
    Hour,
    Minute,
    Second,
}

/// The `Item`s these grammars are made of.
#[derive(Clone, Copy)]
enum Item {
    /// `Item::Numeric`: whitespace, then the digits (a year may carry a sign).
    Numeric(Field),
    /// `Item::Space`: any whitespace, none included.
    Space,
    /// `Item::Literal`.
    Literal(&'static str),
    /// `Fixed::Nanosecond`: a `.` and its digits, or nothing.
    Nanosecond,
}

/// `parse_internal`: the items in order; what is left over is the caller's.
fn parse_items<'a>(parsed: &mut Parsed, mut s: &'a str, items: &[Item]) -> Result<&'a str, Kind> {
    for &item in items {
        match item {
            Item::Literal(prefix) => {
                if s.len() < prefix.len() {
                    return Err(Kind::TooShort);
                }
                s = s.strip_prefix(prefix).ok_or(Kind::Invalid)?;
            }
            Item::Space => s = s.trim_start(),
            Item::Numeric(field) => {
                s = s.trim_start();
                let (rest, value) = match field {
                    Field::Year => {
                        if let Some(digits) = s.strip_prefix('-') {
                            let (rest, value) = number(digits, 1, usize::MAX)?;
                            (rest, 0_i64.checked_sub(value).ok_or(Kind::OutOfRange)?)
                        } else if let Some(digits) = s.strip_prefix('+') {
                            number(digits, 1, usize::MAX)?
                        } else {
                            // without a sign, the year keeps to its four digits
                            number(s, 1, 4)?
                        }
                    }
                    _ => number(s, 1, 2)?,
                };
                s = rest;
                parsed.set(field, value)?;
            }
            Item::Nanosecond => {
                if let Some(digits) = s.strip_prefix('.') {
                    let (rest, nanos) = nanosecond(digits)?;
                    s = rest;
                    set_if_consistent(&mut parsed.nanosecond, nanos)?;
                }
            }
        }
    }
    Ok(s)
}

/// `parse`: the items, and nothing left over.
fn parse_all(text: &str, items: &[Item]) -> Result<Parsed, Kind> {
    let mut parsed = Parsed::default();
    match parse_items(&mut parsed, text, items)? {
        "" => Ok(parsed),
        _ => Err(Kind::TooLong),
    }
}

const DATE_ITEMS: &[Item] = &[
    Item::Numeric(Field::Year),
    Item::Space,
    Item::Literal("-"),
    Item::Numeric(Field::Month),
    Item::Space,
    Item::Literal("-"),
    Item::Numeric(Field::Day),
];

const TIME_ITEMS: &[Item] = &[
    Item::Numeric(Field::Hour),
    Item::Space,
    Item::Literal(":"),
    Item::Numeric(Field::Minute),
    Item::Space,
    Item::Literal(":"),
    Item::Numeric(Field::Second),
    Item::Nanosecond,
    Item::Space,
];

/// `parse_rfc3339_relaxed`, then `FromStr for DateTime<FixedOffset>`: whitespace may be
/// left at the end, nothing else.
pub(super) fn relaxed(text: &str) -> Result<Stamp, ClockError> {
    let mut parsed = Parsed::default();
    let mut s = parse_items(&mut parsed, text, DATE_ITEMS)?;
    s = match s.as_bytes().first() {
        Some(b't' | b'T' | b' ') => &s[1..],
        Some(_) => return Err(Kind::Invalid.into()),
        None => return Err(Kind::TooShort.into()),
    };
    s = parse_items(&mut parsed, s, TIME_ITEMS)?.trim_start();
    let (s, offset) = match s.get(..3) {
        Some(utc) if utc.eq_ignore_ascii_case("UTC") => (&s[3..], 0),
        _ => timezone_offset(s, Colon::AnyOrSpace)?,
    };
    set_if_consistent(&mut parsed.offset, offset)?;
    if !s.trim_start().is_empty() {
        return Err(Kind::TooLong.into());
    }
    Ok(parsed.to_stamp()?)
}

/// `parse_rfc3339`: fixed widths, the date checked before the separator after it.
pub(super) fn strict(text: &str) -> Result<Stamp, ClockError> {
    Ok(strict_kind(text)?)
}

fn strict_kind(text: &str) -> Result<Stamp, Kind> {
    let bytes = text.as_bytes();
    let Some(fixed) = bytes.get(..19) else {
        return Err(Kind::TooShort);
    };
    let digit = |i: usize| -> Result<u32, Kind> {
        let c = fixed[i];
        if c.is_ascii_digit() {
            Ok(u32::from(c - b'0'))
        } else {
            Err(Kind::Invalid)
        }
    };
    let separator = |i: usize, allowed: &[u8]| -> Result<(), Kind> {
        if allowed.contains(&fixed[i]) {
            Ok(())
        } else {
            Err(Kind::Invalid)
        }
    };

    let year = digit(0)? * 1000 + digit(1)? * 100 + digit(2)? * 10 + digit(3)?;
    separator(4, b"-")?;
    let month = digit(5)? * 10 + digit(6)?;
    separator(7, b"-")?;
    let day = digit(8)? * 10 + digit(9)?;
    let date = i32::try_from(year)
        .ok()
        .and_then(|year| Day::new(year, month, day))
        .ok_or(Kind::OutOfRange)?;
    separator(10, b"tT ")?;
    let hour = digit(11)? * 10 + digit(12)?;
    separator(13, b":")?;
    let minute = digit(14)? * 10 + digit(15)?;
    separator(16, b":")?;
    let (second, leap) = match digit(17)? * 10 + digit(18)? {
        // RFC 3339 allows a leap second
        60 => (59, NANOS_PER_SECOND),
        second => (second, 0),
    };

    let (s, nanos) = if bytes.get(19) == Some(&b'.') {
        let (s, nanos) = nanosecond(&text[20..])?;
        (s, leap + nanos)
    } else {
        (&text[19..], leap)
    };
    let time = Time::with_nanos(hour, minute, second, nanos).ok_or(Kind::OutOfRange)?;

    let (s, offset) = timezone_offset(s, Colon::One)?;
    if !s.is_empty() {
        return Err(Kind::TooLong);
    }
    if !is_offset(offset) {
        return Err(Kind::OutOfRange);
    }
    Stamp::from_local(WallClock::of(date, time), offset).ok_or(Kind::Impossible)
}

/// `FromStr for NaiveDate`: spaces allowed around the dashes and at the end.
pub(super) fn day(text: &str) -> Result<Day, ClockError> {
    const ITEMS: &[Item] = &[
        Item::Numeric(Field::Year),
        Item::Space,
        Item::Literal("-"),
        Item::Numeric(Field::Month),
        Item::Space,
        Item::Literal("-"),
        Item::Numeric(Field::Day),
        Item::Space,
    ];
    Ok(parse_all(text, ITEMS)?.to_date()?)
}

/// `NaiveDate::parse_from_str(text, "%Y-%m-%d")`.
pub(super) fn ymd(text: &str) -> Result<Day, ClockError> {
    const ITEMS: &[Item] = &[
        Item::Numeric(Field::Year),
        Item::Literal("-"),
        Item::Numeric(Field::Month),
        Item::Literal("-"),
        Item::Numeric(Field::Day),
    ];
    Ok(parse_all(text, ITEMS)?.to_date()?)
}

/// `NaiveTime::parse_from_str(text, "%H:%M:%S")`.
pub(super) fn hms(text: &str) -> Result<Time, ClockError> {
    const ITEMS: &[Item] = &[
        Item::Numeric(Field::Hour),
        Item::Literal(":"),
        Item::Numeric(Field::Minute),
        Item::Literal(":"),
        Item::Numeric(Field::Second),
    ];
    Ok(parse_all(text, ITEMS)?.to_time()?)
}

/// `NaiveDateTime::parse_from_str(text, "%Y%m%d_%H%M%S")`.
pub(super) fn id_stem(text: &str) -> Result<WallClock, ClockError> {
    const ITEMS: &[Item] = &[
        Item::Numeric(Field::Year),
        Item::Numeric(Field::Month),
        Item::Numeric(Field::Day),
        Item::Literal("_"),
        Item::Numeric(Field::Hour),
        Item::Numeric(Field::Minute),
        Item::Numeric(Field::Second),
    ];
    Ok(parse_all(text, ITEMS)?.to_wall()?)
}
