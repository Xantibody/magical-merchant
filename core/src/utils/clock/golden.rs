//! What each spelling reads as and prints as, frozen from chrono 0.4.45, the library this
//! module first wrapped. The callers' own tests pin the bytes they persist; these pin the
//! grammar behind them, row by row, error words included, so a change of backend cannot
//! quietly accept, refuse or respell anything.

use std::time::{Duration, SystemTime};

use super::{ClockError, Day, Stamp, Time, UtcStamp, WallClock, Zone};

fn shown<T>(result: Result<T, ClockError>, show: impl Fn(T) -> String) -> String {
    match result {
        Ok(value) => format!("ok {}", show(value)),
        Err(e) => format!("err {e}"),
    }
}

/// Every row's outcome against the frozen one, all rows at once so one run shows them all.
fn check(rows: &[(&str, &str)], read: impl Fn(&str) -> String) {
    let got: Vec<(&str, String)> = rows.iter().map(|(text, _)| (*text, read(text))).collect();
    let want: Vec<(&str, String)> = rows
        .iter()
        .map(|(text, outcome)| (*text, (*outcome).to_string()))
        .collect();
    assert_eq!(got, want);
}

fn stamp(text: &str) -> Stamp {
    text.parse().unwrap()
}

fn utc(text: &str) -> UtcStamp {
    text.parse().unwrap()
}

/// The fraction is written with 0, 3, 6 or 9 digits, the fewest that hold it; the offset is
/// rounded to the minute, and `Z` (only in `rfc3339_z`) is decided before that rounding.
#[test]
fn rfc3339_golden() {
    let fractions = [
        0,
        930_000_000,
        646_271_000,
        646_270_000,
        49_896_533,
        49_896_530,
        1,
        100_000_000,
    ];
    let offsets = [
        9 * 3600,
        -(5 * 3600 + 30 * 60),
        0,
        9 * 3600 + 18 * 60 + 59,
        -20,
    ];
    let mut got = Vec::new();
    for offset in offsets {
        for nanos in fractions {
            let at = Stamp::new(2026, 3, 20, 14, 30, 45, offset)
                .unwrap()
                .with_nanosecond(nanos)
                .unwrap();
            got.push(format!("{} {}", at.rfc3339(), at.rfc3339_z()));
        }
    }

    assert_eq!(
        got,
        vec![
            "2026-03-20T14:30:45+09:00 2026-03-20T14:30:45+09:00",
            "2026-03-20T14:30:45.930+09:00 2026-03-20T14:30:45.930+09:00",
            "2026-03-20T14:30:45.646271+09:00 2026-03-20T14:30:45.646271+09:00",
            "2026-03-20T14:30:45.646270+09:00 2026-03-20T14:30:45.646270+09:00",
            "2026-03-20T14:30:45.049896533+09:00 2026-03-20T14:30:45.049896533+09:00",
            "2026-03-20T14:30:45.049896530+09:00 2026-03-20T14:30:45.049896530+09:00",
            "2026-03-20T14:30:45.000000001+09:00 2026-03-20T14:30:45.000000001+09:00",
            "2026-03-20T14:30:45.100+09:00 2026-03-20T14:30:45.100+09:00",
            "2026-03-20T14:30:45-05:30 2026-03-20T14:30:45-05:30",
            "2026-03-20T14:30:45.930-05:30 2026-03-20T14:30:45.930-05:30",
            "2026-03-20T14:30:45.646271-05:30 2026-03-20T14:30:45.646271-05:30",
            "2026-03-20T14:30:45.646270-05:30 2026-03-20T14:30:45.646270-05:30",
            "2026-03-20T14:30:45.049896533-05:30 2026-03-20T14:30:45.049896533-05:30",
            "2026-03-20T14:30:45.049896530-05:30 2026-03-20T14:30:45.049896530-05:30",
            "2026-03-20T14:30:45.000000001-05:30 2026-03-20T14:30:45.000000001-05:30",
            "2026-03-20T14:30:45.100-05:30 2026-03-20T14:30:45.100-05:30",
            "2026-03-20T14:30:45+00:00 2026-03-20T14:30:45Z",
            "2026-03-20T14:30:45.930+00:00 2026-03-20T14:30:45.930Z",
            "2026-03-20T14:30:45.646271+00:00 2026-03-20T14:30:45.646271Z",
            "2026-03-20T14:30:45.646270+00:00 2026-03-20T14:30:45.646270Z",
            "2026-03-20T14:30:45.049896533+00:00 2026-03-20T14:30:45.049896533Z",
            "2026-03-20T14:30:45.049896530+00:00 2026-03-20T14:30:45.049896530Z",
            "2026-03-20T14:30:45.000000001+00:00 2026-03-20T14:30:45.000000001Z",
            "2026-03-20T14:30:45.100+00:00 2026-03-20T14:30:45.100Z",
            "2026-03-20T14:30:45+09:19 2026-03-20T14:30:45+09:19",
            "2026-03-20T14:30:45.930+09:19 2026-03-20T14:30:45.930+09:19",
            "2026-03-20T14:30:45.646271+09:19 2026-03-20T14:30:45.646271+09:19",
            "2026-03-20T14:30:45.646270+09:19 2026-03-20T14:30:45.646270+09:19",
            "2026-03-20T14:30:45.049896533+09:19 2026-03-20T14:30:45.049896533+09:19",
            "2026-03-20T14:30:45.049896530+09:19 2026-03-20T14:30:45.049896530+09:19",
            "2026-03-20T14:30:45.000000001+09:19 2026-03-20T14:30:45.000000001+09:19",
            "2026-03-20T14:30:45.100+09:19 2026-03-20T14:30:45.100+09:19",
            "2026-03-20T14:30:45-00:00 2026-03-20T14:30:45-00:00",
            "2026-03-20T14:30:45.930-00:00 2026-03-20T14:30:45.930-00:00",
            "2026-03-20T14:30:45.646271-00:00 2026-03-20T14:30:45.646271-00:00",
            "2026-03-20T14:30:45.646270-00:00 2026-03-20T14:30:45.646270-00:00",
            "2026-03-20T14:30:45.049896533-00:00 2026-03-20T14:30:45.049896533-00:00",
            "2026-03-20T14:30:45.049896530-00:00 2026-03-20T14:30:45.049896530-00:00",
            "2026-03-20T14:30:45.000000001-00:00 2026-03-20T14:30:45.000000001-00:00",
            "2026-03-20T14:30:45.100-00:00 2026-03-20T14:30:45.100-00:00",
        ]
    );
}

/// The relaxed grammar serde, `FromStr` and the CLI's `--time` read with.
#[test]
fn relaxed_rfc3339_reads() {
    check(RELAXED, |text| {
        shown(text.parse::<Stamp>(), |at| at.rfc3339_z())
    });
}

const RELAXED: &[(&str, &str)] = &[
    ("2026-03-20T14:30:45+09:00", "ok 2026-03-20T14:30:45+09:00"),
    (
        "2026-03-20T14:30:45.120+09:00",
        "ok 2026-03-20T14:30:45.120+09:00",
    ),
    ("2026-03-20 14:30:45+09:00", "ok 2026-03-20T14:30:45+09:00"),
    ("2026-03-20t14:30:45+09:00", "ok 2026-03-20T14:30:45+09:00"),
    ("2026-03-20T14:30:45+0900", "ok 2026-03-20T14:30:45+09:00"),
    ("2026-03-20T14:30:45+09 00", "ok 2026-03-20T14:30:45+09:00"),
    (
        "2026-03-20T14:30:45+09 : 00",
        "ok 2026-03-20T14:30:45+09:00",
    ),
    ("2026-03-20T14:30:45+09::00", "ok 2026-03-20T14:30:45+09:00"),
    ("2026-03-20T05:30:45 UTC", "ok 2026-03-20T05:30:45Z"),
    ("2026-03-20T05:30:45 utc", "ok 2026-03-20T05:30:45Z"),
    ("2026-03-20T05:30:45UTC", "ok 2026-03-20T05:30:45Z"),
    ("2026-03-20T05:30:45uTc", "ok 2026-03-20T05:30:45Z"),
    ("2026-03-20T05:30:45z", "ok 2026-03-20T05:30:45Z"),
    ("2026-03-20T05:30:45 Z", "ok 2026-03-20T05:30:45Z"),
    (
        "2026-03-20T09:30:45\u{2212}05:00",
        "ok 2026-03-20T09:30:45-05:00",
    ),
    ("2026-3-2T4:3:5+09:00", "ok 2026-03-02T04:03:05+09:00"),
    (
        "2026 - 03 - 20 T14 : 30 : 45 +09:00",
        "err input contains invalid characters",
    ),
    (
        "2026 - 03 - 20T14 : 30 : 45 +09:00",
        "ok 2026-03-20T14:30:45+09:00",
    ),
    ("2026-03-20  14:30:45+09:00", "ok 2026-03-20T14:30:45+09:00"),
    (" 2026-03-20T14:30:45+09:00", "ok 2026-03-20T14:30:45+09:00"),
    ("2026-03-20T14:30:45+09:00 ", "ok 2026-03-20T14:30:45+09:00"),
    (
        "2026-03-20T14:30:45+09:00\n",
        "ok 2026-03-20T14:30:45+09:00",
    ),
    ("2026-03-20T14:30:45 +09:00", "ok 2026-03-20T14:30:45+09:00"),
    (
        "2026-03-20T14:30:45.1234567891+09:00",
        "ok 2026-03-20T14:30:45.123456789+09:00",
    ),
    (
        "2026-03-20T14:30:45.12345678912345678901234+09:00",
        "ok 2026-03-20T14:30:45.123456789+09:00",
    ),
    (
        "2026-03-20T14:30:45.+09:00",
        "err input contains invalid characters",
    ),
    (
        "2026-03-20T14:30:45. 5+09:00",
        "err input contains invalid characters",
    ),
    (
        "2026-03-20T14:30:45,5+09:00",
        "err input contains invalid characters",
    ),
    ("2026-03-20T14:30:45+24:00", "err input is out of range"),
    ("2026-03-20T14:30:45+23:59", "ok 2026-03-20T14:30:45+23:59"),
    ("2026-03-20T14:30:45-23:59", "ok 2026-03-20T14:30:45-23:59"),
    ("2026-03-20T14:30:45+09:60", "err input is out of range"),
    (
        "2026-03-20T14:30:45+9:00",
        "err input contains invalid characters",
    ),
    ("2026-03-20T14:30:45+09", "err premature end of input"),
    ("2026-03-20T14:30:45+09:0", "err premature end of input"),
    ("2026-03-20T14:30:45", "err premature end of input"),
    ("2026-03-20T14:30:45+09:00x", "err trailing input"),
    ("2026-03-20T14:30:45+09:00:00", "err trailing input"),
    (
        "2026-03-20T14:30+09:00",
        "err input contains invalid characters",
    ),
    ("2026-03-20", "err premature end of input"),
    (
        "2026-03-20X14:30:45Z",
        "err input contains invalid characters",
    ),
    ("", "err premature end of input"),
    ("abc", "err input contains invalid characters"),
    ("2026-13-20T14:30:45Z", "err input is out of range"),
    ("2026-02-30T14:30:45Z", "err input is out of range"),
    ("2024-02-29T14:30:45Z", "ok 2024-02-29T14:30:45Z"),
    ("2026-03-32T00:00:00Z", "err input is out of range"),
    ("2026-03-20T24:00:00Z", "err input is out of range"),
    ("2026-03-20T23:60:00Z", "err input is out of range"),
    ("2026-03-20T23:59:60Z", "ok 2026-03-20T23:59:60Z"),
    ("2026-03-20T23:59:60.5Z", "ok 2026-03-20T23:59:60.500Z"),
    ("2026-03-20T14:30:60+09:00", "ok 2026-03-20T14:30:60+09:00"),
    ("2026-03-20T14:30:61+09:00", "err input is out of range"),
    ("2026-03-20T00:00:00.000000000Z", "ok 2026-03-20T00:00:00Z"),
    ("2026-03-20T14:30:45.5-00:00", "ok 2026-03-20T14:30:45.500Z"),
    ("9999-12-31T23:00:00Z", "ok 9999-12-31T23:00:00Z"),
    ("+10000-01-01T00:00:00Z", "ok +10000-01-01T00:00:00Z"),
    (
        "10000-01-01T00:00:00Z",
        "err input contains invalid characters",
    ),
    ("-0001-01-01T00:00:00Z", "ok -0001-01-01T00:00:00Z"),
    ("0000-01-01T00:00:00Z", "ok 0000-01-01T00:00:00Z"),
    ("0999-01-01T00:00:00+09:00", "ok 0999-01-01T00:00:00+09:00"),
    ("+2026-03-20T14:30:45Z", "ok 2026-03-20T14:30:45Z"),
    ("2026-003-20T14:30:45Z", "err input is out of range"),
    (
        "02026-03-20T14:30:45Z",
        "err input contains invalid characters",
    ),
    ("+262142-12-31T23:59:59Z", "ok +262142-12-31T23:59:59Z"),
    ("+262143-01-01T00:00:00Z", "err input is out of range"),
    (
        "+262142-12-31T23:59:59-01:00",
        "err no possible date and time matching input",
    ),
    ("-262143-01-01T00:00:00Z", "ok -262143-01-01T00:00:00Z"),
    (
        "-262143-01-01T00:00:00+01:00",
        "err no possible date and time matching input",
    ),
    ("+9999999999-01-01T00:00:00Z", "err input is out of range"),
    (
        "+99999999999999999999-01-01T00:00:00Z",
        "err input is out of range",
    ),
];

/// The same grammar into UTC: any offset is turned into UTC, nothing else changes.
#[test]
fn relaxed_rfc3339_reads_into_utc() {
    check(
        &[
            (
                "2026-08-05T09:00:00.120+09:00",
                "ok 2026-08-05T00:00:00.120+00:00",
            ),
            ("2026-08-05T00:00:00Z", "ok 2026-08-05T00:00:00+00:00"),
            ("2026-03-20T14:30:60+09:00", "ok 2026-03-20T05:30:60+00:00"),
            ("+262142-12-31T23:59:59Z", "ok +262142-12-31T23:59:59+00:00"),
            ("bad", "err input contains invalid characters"),
        ],
        |text| shown(text.parse::<UtcStamp>(), |at| at.rfc3339()),
    );
}

/// The strict grammar repair and a metadata edit read with.
#[test]
fn strict_rfc3339_reads() {
    check(
        &[
            ("2026-03-20T14:30:45+09:00", "ok 2026-03-20T14:30:45+09:00"),
            (
                "2026-03-20T14:30:45.370362+09:00",
                "ok 2026-03-20T14:30:45.370362+09:00",
            ),
            (
                "2026-03-20T14:30:45.1234567891+09:00",
                "ok 2026-03-20T14:30:45.123456789+09:00",
            ),
            ("2026-03-20T14:30:60+09:00", "ok 2026-03-20T14:30:60+09:00"),
            (
                "2026-03-20T14:30:60.5+09:00",
                "ok 2026-03-20T14:30:60.500+09:00",
            ),
            ("2026-03-20 14:30:45+09:00", "ok 2026-03-20T14:30:45+09:00"),
            ("2026-03-20t14:30:45+09:00", "ok 2026-03-20T14:30:45+09:00"),
            ("2026-03-20T05:30:45z", "ok 2026-03-20T05:30:45Z"),
            ("2026-03-20T05:30:45Z", "ok 2026-03-20T05:30:45Z"),
            (
                "2026-03-20T09:30:45\u{2212}05:00",
                "ok 2026-03-20T09:30:45-05:00",
            ),
            (
                "2026-03-20T14:30+09:00",
                "err input contains invalid characters",
            ),
            ("2026-03-20", "err premature end of input"),
            (
                "2026-03-20T14:30:45+0900",
                "err input contains invalid characters",
            ),
            (
                "2026-03-20T05:30:45 UTC",
                "err input contains invalid characters",
            ),
            (
                "2026-3-2T4:3:5+09:00",
                "err input contains invalid characters",
            ),
            (
                "2026-03-20T14:30:45.+09:00",
                "err input contains invalid characters",
            ),
            ("2026-03-20T14:30:45+24:00", "err input is out of range"),
            ("2026-03-20T14:30:45+09:60", "err input is out of range"),
            (
                "+10000-01-01T00:00:00Z",
                "err input contains invalid characters",
            ),
            ("9999-12-31T23:00:00Z", "ok 9999-12-31T23:00:00Z"),
            ("2026-02-30T00:00:00Z", "err input is out of range"),
            ("2026-13-01T00:00:00Z", "err input is out of range"),
            ("2026-03-20T24:00:00Z", "err input is out of range"),
            ("2026-03-20T14:60:00Z", "err input is out of range"),
            ("2026-03-20T14:30:61Z", "err input is out of range"),
            ("2026-03-20T14:30:45Z ", "err trailing input"),
            ("2026-03-20T14:30:45", "err premature end of input"),
            ("2026-03-20T14:30:45+09", "err premature end of input"),
            ("0000-01-01T00:00:00+01:00", "ok 0000-01-01T00:00:00+01:00"),
            (
                "2026-03-20X14:30:45Z",
                "err input contains invalid characters",
            ),
            (
                "2026/03/20T14:30:45Z",
                "err input contains invalid characters",
            ),
        ],
        |text| shown(Stamp::parse_strict(text), |at| at.rfc3339_z()),
    );
}

/// The date type's own grammar, the one serde reads a `Day` with.
#[test]
fn a_day_reads_by_its_own_grammar() {
    check(
        &[
            ("2026-03-01", "ok 2026-03-01"),
            ("2026-3-1", "ok 2026-03-01"),
            ("2026 -03-01", "ok 2026-03-01"),
            ("2026-03-01 ", "ok 2026-03-01"),
            (" 2026-03-01", "ok 2026-03-01"),
            ("+02026-03-01", "ok 2026-03-01"),
            ("2026 - 3 - 1", "ok 2026-03-01"),
            ("2026- 03-01", "ok 2026-03-01"),
            ("-0001-01-01", "ok -0001-01-01"),
            ("+10000-01-01", "ok +10000-01-01"),
            ("0999-01-02", "ok 0999-01-02"),
            ("999-1-2", "ok 0999-01-02"),
            ("+262142-12-31", "ok +262142-12-31"),
            ("+262143-01-01", "err input is out of range"),
            ("2026-02-30", "err input is out of range"),
            ("2026-13-01", "err input is out of range"),
            ("2026-00-01", "err input is out of range"),
            ("abc", "err input contains invalid characters"),
            ("2026-03-01x", "err trailing input"),
            ("2026-03", "err premature end of input"),
            ("", "err premature end of input"),
            ("2026-03-01T00:00", "err trailing input"),
            ("20260301", "err input contains invalid characters"),
            ("2026/03/01", "err input contains invalid characters"),
            ("+9999999999-01-01", "err input is out of range"),
            ("+99999999999999999999-01-01", "err input is out of range"),
        ],
        |text| shown(text.parse::<Day>(), |day| day.to_string()),
    );
}

/// `%Y-%m-%d`, what a file name and an argument are read with.
#[test]
fn a_day_reads_by_ymd() {
    check(
        &[
            ("2026-03-01", "ok 2026-03-01"),
            ("2026-3-1", "ok 2026-03-01"),
            ("2026 -03-01", "err input contains invalid characters"),
            ("2026-03-01 ", "err trailing input"),
            (" 2026-03-01", "ok 2026-03-01"),
            ("+02026-03-01", "ok 2026-03-01"),
            ("2026 - 3 - 1", "err input contains invalid characters"),
            ("2026- 03-01", "ok 2026-03-01"),
            ("-0001-01-01", "ok -0001-01-01"),
            ("+10000-01-01", "ok +10000-01-01"),
            ("0999-01-02", "ok 0999-01-02"),
            ("999-1-2", "ok 0999-01-02"),
            ("+262142-12-31", "ok +262142-12-31"),
            ("+262143-01-01", "err input is out of range"),
            ("2026-02-30", "err input is out of range"),
            ("2026-13-01", "err input is out of range"),
            ("2026-00-01", "err input is out of range"),
            ("abc", "err input contains invalid characters"),
            ("2026-03-01x", "err trailing input"),
            ("2026-03", "err premature end of input"),
            ("", "err premature end of input"),
            ("2026-03-01T00:00", "err trailing input"),
            ("20260301", "err input contains invalid characters"),
            ("2026/03/01", "err input contains invalid characters"),
            ("+9999999999-01-01", "err input is out of range"),
            ("+99999999999999999999-01-01", "err input is out of range"),
        ],
        |text| shown(Day::parse_ymd(text), |day| day.ymd()),
    );
}

/// `%H:%M:%S`, a Scrawl line's time.
#[test]
fn a_time_reads_by_hms() {
    check(
        &[
            ("09:05:07", "ok 09:05:07 09:05"),
            ("9:5:7", "ok 09:05:07 09:05"),
            (" 09:05:07", "ok 09:05:07 09:05"),
            ("09: 05:07", "ok 09:05:07 09:05"),
            ("09:05:07 ", "err trailing input"),
            ("23:59:60", "ok 23:59:60 23:59"),
            ("24:00:00", "err input is out of range"),
            ("23:60:00", "err input is out of range"),
            ("23:59:61", "err input is out of range"),
            ("09:05", "err premature end of input"),
            ("", "err premature end of input"),
            ("09:05:07.5", "err trailing input"),
            ("aa:bb:cc", "err input contains invalid characters"),
            ("009:05:07", "err input contains invalid characters"),
            ("+9:05:07", "err input contains invalid characters"),
        ],
        |text| {
            shown(Time::parse_hms(text), |time| {
                format!("{} {}", time.hms(), time.hm())
            })
        },
    );
}

/// `%Y%m%d_%H%M%S`, an ID's stem.
#[test]
fn an_id_stem_reads() {
    check(
        &[
            ("20260917_140300", "ok 20260917_140300"),
            ("20260917_235960", "ok 20260917_235960"),
            ("20261317_140300", "err input is out of range"),
            ("20260230_000000", "err input is out of range"),
            ("20260917_240000", "err input is out of range"),
            ("2026917_140300", "err input is out of range"),
            ("20260917_14030", "ok 20260917_140300"),
            ("20260917-140300", "err input contains invalid characters"),
            ("20260917_140300-2", "err trailing input"),
            ("+20260917_140300", "err input contains invalid characters"),
            (" 20260917_140300", "ok 20260917_140300"),
            ("20260917_ 140300", "ok 20260917_140300"),
            ("", "err premature end of input"),
            ("00000101_000000", "ok 00000101_000000"),
        ],
        |text| shown(WallClock::parse_id_stem(text), |wall| wall.id_stem()),
    );
}

/// Years outside 0..=9999 carry a sign; a leap second prints as 60 wherever seconds show.
#[test]
fn every_printer_spells_edge_values() {
    let mut got = Vec::new();
    for (y, m, d) in [(-1, 1, 1), (0, 1, 1), (999, 1, 2), (10_000, 1, 1)] {
        let day = Day::new(y, m, d).unwrap();
        got.push(format!(
            "{} {} {} {}",
            day.ymd(),
            day,
            serde_json::to_string(&day).unwrap(),
            WallClock::new(y, m, d, 0, 0, 0).unwrap().id_stem(),
        ));
    }
    let leap = stamp("2026-03-20T23:59:60.5+09:00");
    got.push(format!(
        "{} {} {} {} {} {}",
        leap.id_stem(),
        leap.list_minute(),
        leap.month_day(),
        leap.wall().time().hms(),
        leap.wall().second(),
        serde_json::to_string(&leap).unwrap(),
    ));
    let leap_utc = utc("2026-03-20T23:59:60.5Z");
    got.push(format!(
        "{} {} {} {} {}",
        leap_utc.conflict_stamp(),
        leap_utc.unix_seconds(),
        leap_utc.subsec_nanos(),
        leap_utc.unix_millis(),
        serde_json::to_string(&leap_utc).unwrap(),
    ));

    assert_eq!(
        got,
        vec![
            "-0001-01-01 -0001-01-01 \"-0001-01-01\" -00010101_000000",
            "0000-01-01 0000-01-01 \"0000-01-01\" 00000101_000000",
            "0999-01-02 0999-01-02 \"0999-01-02\" 09990102_000000",
            "+10000-01-01 +10000-01-01 \"+10000-01-01\" +100000101_000000",
            "20260320_235960 2026-03-20 23:59 03/20 23:59:60 59 \"2026-03-20T23:59:60.500+09:00\"",
            "20260320-235960 1774051199 1500000000 1774051200500 \"2026-03-20T23:59:60.500Z\"",
        ]
    );
}

/// Seconds are exact steps; stepping out of a leap second lands on the next minute's
/// fraction, and a step of nothing stays in it.
#[test]
fn seconds_and_days_step_exactly() {
    let leap = stamp("2026-03-20T14:30:60.5+09:00");
    let late = stamp("2026-12-31T23:59:59+09:00");
    let wall = WallClock::new(2024, 2, 28, 23, 0, 0).unwrap();
    let got = vec![
        leap.plus_seconds(1).rfc3339(),
        leap.plus_seconds(-1).rfc3339(),
        leap.plus_seconds(0).rfc3339(),
        late.plus_seconds(1).rfc3339(),
        late.plus_seconds(-86_400 * 365).rfc3339(),
        utc("2026-08-05T00:00:00.120Z").plus_seconds(-30).rfc3339(),
        wall.plus_seconds(3600).id_stem(),
        wall.plus_seconds(86_400 + 3600).id_stem(),
        format!(
            "{:?}",
            Day::new(2024, 2, 28).unwrap().plus_days(1).map(|d| d.ymd())
        ),
        format!(
            "{:?}",
            Day::new(2024, 2, 28).unwrap().plus_days(2).map(|d| d.ymd())
        ),
        format!(
            "{:?}",
            Day::new(2026, 1, 1).unwrap().plus_days(-1).map(|d| d.ymd())
        ),
        format!(
            "{:?}",
            Day::new(2026, 1, 1)
                .unwrap()
                .plus_days(1 << 40)
                .map(|d| d.ymd())
        ),
        format!(
            "{:?}",
            Day::new(2026, 1, 1)
                .unwrap()
                .plus_days(i64::MAX)
                .map(|d| d.ymd())
        ),
    ];

    assert_eq!(
        got,
        vec![
            "2026-03-20T14:31:00.500+09:00",
            "2026-03-20T14:30:59.500+09:00",
            "2026-03-20T14:30:60.500+09:00",
            "2027-01-01T00:00:00+09:00",
            "2025-12-31T23:59:59+09:00",
            "2026-08-04T23:59:30.120+00:00",
            "20240229_000000",
            "20240301_000000",
            "Some(\"2024-02-29\")",
            "Some(\"2024-03-01\")",
            "Some(\"2025-12-31\")",
            "None",
            "None",
        ]
    );
}

/// Equal and ordered by the instant alone; a leap second sorts after its second 59.
#[test]
fn stamps_compare_by_instant() {
    assert_eq!(
        stamp("2026-03-20T14:30:45+09:00"),
        stamp("2026-03-20T05:30:45Z")
    );
    assert!(stamp("2026-03-20T23:59:60Z") > stamp("2026-03-20T23:59:59.999999999Z"));
    assert!(stamp("2026-03-20T23:59:60.999Z") < stamp("2026-03-21T00:00:00Z"));
    assert!(utc("2026-03-20T23:59:60Z") > utc("2026-03-20T23:59:59.999999999Z"));
    assert_eq!(
        utc("2026-03-20T14:30:45+09:00"),
        utc("2026-03-20T05:30:45Z")
    );
}

/// A stamp's wall clock and date are its own offset's; a fixed zone places a wall clock.
#[test]
fn walls_days_and_fixed_zones() {
    let west = stamp("2026-03-20T23:30:00-05:00");
    let wall = WallClock::new(2026, 3, 20, 14, 30, 45).unwrap();
    let got = vec![
        west.day().ymd(),
        west.wall().id_stem(),
        format!("{}", west.wall().weekday_from_sunday()),
        format!(
            "{:?}",
            Zone::fixed(9 * 3600)
                .and_then(|z| z.earliest(wall))
                .map(|s| s.rfc3339())
        ),
        format!(
            "{:?}",
            Zone::fixed(-86_399)
                .and_then(|z| z.earliest(wall))
                .map(|s| s.rfc3339())
        ),
        format!("{:?}", Zone::fixed(86_400).map(|_| ())),
        format!(
            "{:?}",
            Stamp::new(2026, 2, 30, 0, 0, 0, 0).map(|s| s.rfc3339())
        ),
        format!(
            "{:?}",
            Stamp::new(2026, 3, 20, 0, 0, 0, 86_400).map(|s| s.rfc3339())
        ),
        format!("{:?}", Time::new(23, 59, 60).map(|t| t.hms())),
        format!(
            "{:?}",
            UtcStamp::new(2026, 3, 20, 24, 0, 0).map(|s| s.rfc3339())
        ),
    ];

    assert_eq!(
        got,
        vec![
            "2026-03-20",
            "20260320_233000",
            "5",
            "Some(\"2026-03-20T14:30:45+09:00\")",
            "Some(\"2026-03-20T14:30:45-24:00\")",
            "None",
            "None",
            "None",
            "None",
            "None",
        ]
    );
}

/// A mtime keeps every digit; before 1970 it counts down from the epoch.
#[test]
fn system_times_read_exactly() {
    let got: Vec<String> = [
        SystemTime::UNIX_EPOCH + Duration::from_nanos(1_234_567_891),
        SystemTime::UNIX_EPOCH - Duration::from_micros(1_500),
    ]
    .iter()
    .map(|t| {
        let at = UtcStamp::from_system_time(*t);
        format!(
            "{} {} {}",
            at.rfc3339(),
            at.unix_seconds(),
            at.unix_millis()
        )
    })
    .collect();

    assert_eq!(
        got,
        vec![
            "1970-01-01T00:00:01.234567891+00:00 1 1234",
            "1969-12-31T23:59:59.998500+00:00 -1 -2",
        ]
    );
}

/// What serde says about a value that is not a string at all.
#[test]
fn serde_errors_name_what_was_expected() {
    let got = vec![
        serde_json::from_str::<Stamp>("12").unwrap_err().to_string(),
        serde_json::from_str::<UtcStamp>("12")
            .unwrap_err()
            .to_string(),
        serde_json::from_str::<Day>("12").unwrap_err().to_string(),
        serde_json::from_str::<Stamp>("\"2026-13-01T00:00:00Z\"")
            .unwrap_err()
            .to_string(),
        serde_json::from_str::<Day>("\"2026-13-01\"")
            .unwrap_err()
            .to_string(),
        serde_json::from_str::<UtcStamp>("\"2026-08-05T09:00:00+09:00\"")
            .unwrap()
            .rfc3339_z(),
    ];

    assert_eq!(
        got,
        vec![
            "invalid type: integer `12`, expected an RFC 3339 formatted date and time string at line 1 column 2",
            "invalid type: integer `12`, expected an RFC 3339 formatted date and time string at line 1 column 2",
            "invalid type: integer `12`, expected a formatted date string at line 1 column 2",
            "input is out of range at line 1 column 22",
            "input is out of range at line 1 column 12",
            "2026-08-05T00:00:00Z",
        ]
    );
}
