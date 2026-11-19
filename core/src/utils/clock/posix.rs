//! chrono 0.4.45's grammar for a POSIX `TZ` rule (`TransitionRule::from_tz_string` with
//! RFC 8536's extensions off), to tell which rules chrono read at all.
//!
//! AIDEV-NOTE: only the acceptance is ported; jiff's `TimeZone::posix` still reads the rule.
//! jiff also takes RFC 8536's extensions (a rule time below 0 or past 24h) and offsets up to
//! 25:59:59, where chrono refused the rule and fell through to the platform's zone name, so
//! a `TZ` like that would have moved every local stamp and day file to another zone.

use std::str::FromStr;

/// Whether chrono read `rule` (already trimmed of ASCII whitespace) as a POSIX `TZ` rule.
pub(super) fn chrono_reads(rule: &str) -> bool {
    parse(&mut Cursor(rule.as_bytes())).is_some()
}

struct Cursor<'a>(&'a [u8]);

impl<'a> Cursor<'a> {
    const fn peek(&self) -> Option<u8> {
        self.0.first().copied()
    }

    const fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    fn take_while(&mut self, keep: impl Fn(u8) -> bool) -> &'a [u8] {
        let end = self
            .0
            .iter()
            .position(|&b| !keep(b))
            .unwrap_or(self.0.len());
        let (taken, rest) = self.0.split_at(end);
        self.0 = rest;
        taken
    }

    /// The next byte, which has to be `tag`.
    fn tag(&mut self, tag: u8) -> Option<()> {
        let (&first, rest) = self.0.split_first()?;
        self.0 = rest;
        (first == tag).then_some(())
    }

    /// The next byte if it is `tag`.
    fn optional_tag(&mut self, tag: u8) -> bool {
        self.peek() == Some(tag) && self.tag(tag).is_some()
    }

    /// The digits that follow, as a `T`: none, or too many for `T`, is no number.
    fn int<T: FromStr>(&mut self) -> Option<T> {
        std::str::from_utf8(self.take_while(|b| b.is_ascii_digit()))
            .ok()?
            .parse()
            .ok()
    }
}

/// `std offset [dst [offset] , start [/time] , end [/time]]`.
fn parse(cursor: &mut Cursor<'_>) -> Option<()> {
    name(cursor)?;
    offset(cursor)?;
    if cursor.is_empty() {
        return Some(());
    }
    name(cursor)?;
    match cursor.peek()? {
        // the DST offset defaults to an hour ahead of standard time
        b',' => {}
        _ => {
            offset(cursor)?;
        }
    }
    if cursor.is_empty() {
        return None;
    }
    cursor.tag(b',')?;
    rule_day(cursor)?;
    cursor.tag(b',')?;
    rule_day(cursor)?;
    cursor.is_empty().then_some(())
}

/// A zone abbreviation: letters, or `<…>`; 3 to 7 of letters, digits, `+` and `-`.
fn name(cursor: &mut Cursor<'_>) -> Option<()> {
    let name = if cursor.peek() == Some(b'<') {
        cursor.tag(b'<')?;
        let quoted = cursor.take_while(|b| b != b'>');
        cursor.tag(b'>')?;
        quoted
    } else {
        cursor.take_while(|b| b.is_ascii_alphabetic())
    };
    ((3..=7).contains(&name.len())
        && name
            .iter()
            .all(|&b| b.is_ascii_alphanumeric() || b == b'+' || b == b'-'))
    .then_some(())
}

/// `[+|-]hh[:mm[:ss]]`, under a day.
fn offset(cursor: &mut Cursor<'_>) -> Option<()> {
    let _signed = cursor.optional_tag(b'+') || cursor.optional_tag(b'-');
    hhmmss(cursor, 23)
}

/// `hh[:mm[:ss]]` with the hour at most `max_hour`.
fn hhmmss(cursor: &mut Cursor<'_>, max_hour: i32) -> Option<()> {
    let hour: i32 = cursor.int()?;
    let mut minute = 0;
    let mut second = 0;
    if cursor.optional_tag(b':') {
        minute = cursor.int()?;
        if cursor.optional_tag(b':') {
            second = cursor.int()?;
        }
    }
    ((0..=max_hour).contains(&hour) && (0..=59).contains(&minute) && (0..=59).contains(&second))
        .then_some(())
}

/// `Mm.w.d`, `Jn` or `n`, then an optional `/hh[:mm[:ss]]` of at most 24 hours.
fn rule_day(cursor: &mut Cursor<'_>) -> Option<()> {
    let day = match cursor.peek()? {
        b'M' => {
            cursor.tag(b'M')?;
            let month: u8 = cursor.int()?;
            cursor.tag(b'.')?;
            let week: u8 = cursor.int()?;
            cursor.tag(b'.')?;
            let weekday: u8 = cursor.int()?;
            (1..=12).contains(&month) && (1..=5).contains(&week) && weekday <= 6
        }
        b'J' => {
            cursor.tag(b'J')?;
            (1..=365).contains(&cursor.int::<u16>()?)
        }
        _ => cursor.int::<u16>()? <= 365,
    };
    if !day {
        return None;
    }
    if cursor.optional_tag(b'/') {
        hhmmss(cursor, 24)?;
    }
    Some(())
}
