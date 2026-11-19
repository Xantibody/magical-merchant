//! The device's zone and the offset it puts on an instant: the only thing jiff decides.
//!
//! AIDEV-NOTE: the lookup is chrono's, ported, not jiff's `TimeZone::system()`. jiff never
//! reads Android's updatable tzdata under `/apex/com.android.tzdata` (jiff#582, closed as
//! not planned) and caches the system zone for minutes; chrono looked there first and
//! re-checked at most once a second per thread, so a zone change reached Scrawl, note IDs
//! and frontmatter offsets within a second. Order: `TZ` (empty is UTC), else the bytes of
//! `/etc/localtime`, else the zone name the platform reports, else UTC.
//!
//! AIDEV-NOTE: asks the OS for the zone here rather than through services; threading a zone through every "now" costs more than it gains.

use std::cell::RefCell;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::Path;
use std::sync::OnceLock;
use std::time::SystemTime;

use jiff::Timestamp;
use jiff::civil;
use jiff::tz::{AmbiguousOffset, Offset, TimeZone, TimeZoneDatabase};

use super::civil::WallClock;
use super::posix;
use super::stamp::{Stamp, is_offset};

/// Where a wall clock is read: the device's zone, or a fixed offset.
///
/// A caller that turns a wall clock into an instant takes one, so a test can name the
/// zone instead of depending on the machine it runs on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Zone(Kind);

#[derive(Debug, Clone, PartialEq, Eq)]
enum Kind {
    Local,
    Fixed(i32),
    /// Only tests name a zone by its rules; the app has the device's and fixed offsets.
    #[cfg(test)]
    Rules(TimeZone),
}

impl Zone {
    /// The device's zone.
    #[must_use]
    pub const fn local() -> Self {
        Self(Kind::Local)
    }

    /// `offset_seconds` east of UTC all year round. `None` for a day or more.
    #[must_use]
    pub const fn fixed(offset_seconds: i32) -> Option<Self> {
        if is_offset(offset_seconds) {
            Some(Self(Kind::Fixed(offset_seconds)))
        } else {
            None
        }
    }

    /// A zone with rules of its own, as a test names one.
    #[cfg(test)]
    pub(super) const fn rules(zone: TimeZone) -> Self {
        Self(Kind::Rules(zone))
    }

    /// The instant this wall clock names here, read as chrono's `earliest()` read it. A
    /// wall clock a clock change skips over names none, save the gap's first second; one it
    /// repeats names the later of the two instants.
    #[must_use]
    pub fn earliest(&self, wall: WallClock) -> Option<Stamp> {
        let offset = match &self.0 {
            Kind::Local => earliest_offset(&local_zone(), wall)?,
            Kind::Fixed(offset) => *offset,
            #[cfg(test)]
            Kind::Rules(zone) => earliest_offset(zone, wall)?,
        };
        Stamp::from_local(wall, offset)
    }
}

/// The offset in force at a wall clock, as chrono 0.4.45's `Local` read it, by the wall
/// clock's whole second: none in a gap but for its first second, which takes the offset
/// before the change; in a fold, the smaller offset, the one after the change.
///
/// AIDEV-NOTE: chrono's later-instant fold (its tz code lists the smaller offset first) is
/// kept because repair wrote it into `time:`; the earlier instant, jiff's `Fold { before }`,
/// was rejected as it moves a repaired note an hour from where chrono put it.
///
/// AIDEV-NOTE: chrono's POSIX-rule path (a `TZ` rule, a `TZif` past its last transition) read
/// a southern-hemisphere gap's first second as none; jiff hides a transition's source, so it
/// takes the offset before here, and no clock in that zone ever shows that second.
///
/// AIDEV-NOTE: a wall clock outside jiff's years (-9999 to 9999) names no instant in a
/// zone with rules; only a fixed offset places one. chrono placed it by the zone's last
/// rule, but no record carries such a year in its ID.
fn earliest_offset(zone: &TimeZone, wall: WallClock) -> Option<i32> {
    // a leap second is looked up as its second 59, any fraction as its whole second
    let civil = civil::DateTime::new(
        i16::try_from(wall.year()).ok()?,
        i8::try_from(wall.month()).ok()?,
        i8::try_from(wall.day()).ok()?,
        i8::try_from(wall.hour()).ok()?,
        i8::try_from(wall.minute()).ok()?,
        i8::try_from(wall.second()).ok()?,
        0,
    )
    .ok()?;
    let offset = match zone.to_ambiguous_timestamp(civil).offset() {
        AmbiguousOffset::Unambiguous { offset } | AmbiguousOffset::Fold { after: offset, .. } => {
            offset
        }
        AmbiguousOffset::Gap { before, .. } if starts_gap(zone, civil, before) => before,
        AmbiguousOffset::Gap { .. } => return None,
    }
    .seconds();
    // chrono's `FixedOffset::east_opt` named nothing for a day or more
    is_offset(offset).then_some(offset)
}

/// Whether `civil`, read at `before`, is the instant of the change itself: the second
/// before it is still at `before`.
fn starts_gap(zone: &TimeZone, civil: civil::DateTime, before: Offset) -> bool {
    before
        .to_timestamp(civil)
        .ok()
        .and_then(|at| Timestamp::from_second(at.as_second() - 1).ok())
        .is_some_and(|second_before| zone.to_offset(second_before) == before)
}

/// The device's offset at an instant given as UTC's wall clock.
pub(super) fn local_offset_at(utc: WallClock) -> i32 {
    offset_at(&local_zone(), utc)
}

/// The offset `zone` puts on an instant. An instant past jiff's range takes the offset of
/// the nearest one inside it.
///
/// AIDEV-NOTE: an offset of a day or more (jiff reads up to 25:59:59, from a POSIX rule or
/// a `TZif`) is UTC's here. chrono panicked on one; written as it is, the stamp would not
/// read back and the note would no longer parse. UTC is what a zone that cannot be read
/// gives anyway.
fn offset_at(zone: &TimeZone, utc: WallClock) -> i32 {
    let seconds = utc
        .unix_seconds()
        .clamp(Timestamp::MIN.as_second(), Timestamp::MAX.as_second());
    let instant = Timestamp::from_second(seconds).unwrap_or(Timestamp::UNIX_EPOCH);
    Some(zone.to_offset(instant).seconds())
        .filter(|&offset| is_offset(offset))
        .unwrap_or(0)
}

// ──────────── chrono's offset/local/unix.rs ────────────

/// Where the zone came from, to tell when it may have changed.
#[derive(Debug, PartialEq, Eq)]
enum Source {
    /// `/etc/localtime` (or its absence), by its modification time.
    LocalTime { mtime: SystemTime },
    /// The `TZ` variable, by its value.
    Environment { value: String },
}

impl Source {
    fn new(tz_env: Option<&str>) -> Self {
        tz_env.map_or_else(
            // A missing file (Android's case) or mtime counts as changed at every check, so
            // the zone is looked up again once a second, as chrono did
            || Self::LocalTime {
                mtime: fs::symlink_metadata("/etc/localtime")
                    .and_then(|meta| meta.modified())
                    .unwrap_or_else(|_| SystemTime::now()),
            },
            |value| Self::Environment {
                value: value.to_string(),
            },
        )
    }
}

/// Whether the zone has to be looked up again: the source changed kind, or its value.
fn needs_lookup(old: &Source, new: &Source) -> bool {
    old != new
}

struct Cache {
    zone: TimeZone,
    source: Source,
    last_checked: SystemTime,
}

impl Cache {
    fn new() -> Self {
        let tz_env = env::var("TZ").ok();
        Self {
            last_checked: SystemTime::now(),
            source: Source::new(tz_env.as_deref()),
            zone: current_zone(tz_env.as_deref()),
        }
    }

    /// chrono's `Cache::offset` minus the offset: reused unconditionally for a second,
    /// then looked up again only if its source changed.
    fn refresh(&mut self) {
        let now = SystemTime::now();
        if now
            .duration_since(self.last_checked)
            .is_ok_and(|since| since.as_secs() < 1)
        {
            return;
        }
        let tz_env = env::var("TZ").ok();
        let source = Source::new(tz_env.as_deref());
        if needs_lookup(&self.source, &source) {
            self.zone = current_zone(tz_env.as_deref());
        }
        self.last_checked = now;
        self.source = source;
    }
}

thread_local! {
    static CACHE: RefCell<Option<Cache>> = const { RefCell::new(None) };
}

/// The device's zone, looked up at most once a second on each thread.
fn local_zone() -> TimeZone {
    CACHE.with(|cell| {
        let mut slot = cell.borrow_mut();
        match slot.as_mut() {
            Some(cache) => {
                cache.refresh();
                cache.zone.clone()
            }
            None => slot.insert(Cache::new()).zone.clone(),
        }
    })
}

fn current_zone(tz_env: Option<&str>) -> TimeZone {
    resolve_zone(&Sources {
        tz_env,
        localtime: &|| fs::read("/etc/localtime").ok(),
        platform_name: &|| iana_time_zone::get_timezone().ok(),
        apex: &|name| apex_db().and_then(|db| db.get(name).ok()),
        system: &|name| jiff::tz::db().get(name).ok(),
        read_file: &|path| fs::read(path).ok(),
    })
}

/// Android's updatable tzdata, when the platform names its root and the file is there.
fn apex_db() -> Option<&'static TimeZoneDatabase> {
    static APEX: OnceLock<Option<TimeZoneDatabase>> = OnceLock::new();
    APEX.get_or_init(|| apex_db_under(env::var_os("ANDROID_TZDATA_ROOT")))
        .as_ref()
}

/// The concatenated tzdata at `<root>/etc/tz/tzdata`, where chrono looked first.
///
/// AIDEV-NOTE: gated on the variable and the file at run time, not on
/// `cfg(target_os = "android")`, so every host compiles, lints and tests it; CI builds
/// Android only when the app changes.
fn apex_db_under(root: Option<OsString>) -> Option<TimeZoneDatabase> {
    let path = Path::new(&root?).join("etc/tz/tzdata");
    if !path.is_file() {
        return None;
    }
    TimeZoneDatabase::from_concatenated_path(path).ok()
}

/// What a lookup reads from the outside, each piece asked for only when the order gets
/// to it.
struct Sources<'a> {
    /// `TZ`, when set.
    tz_env: Option<&'a str>,
    /// The bytes of `/etc/localtime` (`TZif`). Android has none.
    localtime: &'a dyn Fn() -> Option<Vec<u8>>,
    /// The zone name the platform reports (`persist.sys.timezone` on Android).
    platform_name: &'a dyn Fn() -> Option<String>,
    /// A name in Android's updatable tzdata.
    apex: &'a dyn Fn(&str) -> Option<TimeZone>,
    /// A name in the system's database (`/usr/share/zoneinfo`, Android's own tzdata).
    system: &'a dyn Fn(&str) -> Option<TimeZone>,
    /// A `TZif` file named by an absolute path.
    read_file: &'a dyn Fn(&Path) -> Option<Vec<u8>>,
}

/// chrono's `current_zone`: `TZ` or `/etc/localtime`, else the platform's zone name, else
/// UTC.
fn resolve_zone(sources: &Sources<'_>) -> TimeZone {
    let named = sources
        .tz_env
        .map_or_else(|| etc_localtime(sources), |tz| from_tz_env(tz, sources));
    named
        .or_else(|| {
            let name = (sources.platform_name)()?;
            (sources.apex)(&name).or_else(|| (sources.system)(&name))
        })
        .unwrap_or(TimeZone::UTC)
}

/// chrono's `TimeZone::from_posix_tz`: empty is UTC; `localtime` is `/etc/localtime`; a name
/// in the updatable tzdata; `:` and a file or name; a file or name; a POSIX rule.
fn from_tz_env(tz: &str, sources: &Sources<'_>) -> Option<TimeZone> {
    if tz.is_empty() {
        return Some(TimeZone::UTC);
    }
    if tz == "localtime" {
        return etc_localtime(sources);
    }
    if let Some(zone) = (sources.apex)(tz) {
        return Some(zone);
    }
    if let Some(file) = tz.strip_prefix(':') {
        return tz_file(file, sources);
    }
    tz_file(tz, sources).or_else(|| {
        let rule = tz.trim_matches(|c: char| c.is_ascii_whitespace());
        if posix::chrono_reads(rule) {
            TimeZone::posix(rule).ok()
        } else {
            None
        }
    })
}

fn etc_localtime(sources: &Sources<'_>) -> Option<TimeZone> {
    (sources.localtime)().and_then(|bytes| TimeZone::tzif("localtime", &bytes).ok())
}

/// chrono's `find_tz_file`: an absolute path as it is, anything else under the zone
/// directories (which the system database reads).
fn tz_file(path: &str, sources: &Sources<'_>) -> Option<TimeZone> {
    if Path::new(path).is_absolute() {
        let bytes = (sources.read_file)(Path::new(path))?;
        TimeZone::tzif(path, &bytes).ok()
    } else {
        (sources.system)(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TESTDATA: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/utils/clock/testdata");
    /// The `TZif` of Asia/Kolkata (+05:30), standing in for `/etc/localtime`.
    const LOCALTIME: &[u8] = include_bytes!("testdata/localtime");

    fn apex() -> TimeZoneDatabase {
        apex_db_under(Some(TESTDATA.into())).unwrap()
    }

    #[allow(clippy::unnecessary_wraps)] // the shape a lookup takes
    fn plus_one(_: &str) -> Option<TimeZone> {
        Some(TimeZone::fixed(Offset::constant(1)))
    }

    fn nothing(_: &str) -> Option<TimeZone> {
        None
    }

    /// The offset, in minutes, of the zone the sources resolve to, in January 2026.
    fn resolved(
        tz_env: Option<&str>,
        localtime: Option<&[u8]>,
        platform_name: Option<&str>,
        with_apex: bool,
        system: &dyn Fn(&str) -> Option<TimeZone>,
    ) -> i32 {
        let db = apex();
        let apex = |name: &str| if with_apex { db.get(name).ok() } else { None };
        let zone = resolve_zone(&Sources {
            tz_env,
            localtime: &|| localtime.map(<[u8]>::to_vec),
            platform_name: &|| platform_name.map(str::to_string),
            apex: &apex,
            system,
            read_file: &|path| (path == Path::new("/zones/kolkata")).then(|| LOCALTIME.to_vec()),
        });
        let january = WallClock::new(2026, 1, 15, 0, 0, 0).unwrap();
        offset_at(&zone, january) / 60
    }

    #[test]
    fn an_empty_tz_is_utc_whatever_else_there_is() {
        assert_eq!(
            resolved(
                Some(""),
                Some(LOCALTIME),
                Some("Asia/Tokyo"),
                true,
                &plus_one
            ),
            0
        );
    }

    #[test]
    fn tz_is_looked_up_in_the_updatable_tzdata_first() {
        assert_eq!(
            resolved(Some("Asia/Tokyo"), Some(LOCALTIME), None, true, &plus_one),
            9 * 60
        );
    }

    #[test]
    fn tz_names_a_zone_in_the_system_database() {
        assert_eq!(
            resolved(Some("Asia/Tokyo"), Some(LOCALTIME), None, false, &plus_one),
            60
        );
        assert_eq!(
            resolved(Some(":Asia/Tokyo"), Some(LOCALTIME), None, false, &plus_one),
            60
        );
    }

    #[test]
    fn tz_names_a_file_by_its_path() {
        assert_eq!(
            resolved(Some(":/zones/kolkata"), None, None, false, &nothing),
            5 * 60 + 30
        );
        assert_eq!(
            resolved(Some("/zones/kolkata"), None, None, false, &nothing),
            5 * 60 + 30
        );
    }

    #[test]
    fn tz_is_a_posix_rule_when_nothing_is_named_so() {
        assert_eq!(
            resolved(Some("EST5EDT,M3.2.0,M11.1.0"), None, None, false, &nothing),
            -5 * 60
        );
    }

    /// chrono read POSIX rules without RFC 8536's extensions, and offsets under a day; a
    /// rule past that falls to the platform's name, as it did there.
    #[test]
    fn a_rule_chrono_did_not_read_falls_to_the_platform_name() {
        for rule in [
            "<+02>-2<+03>,M3.4.4/26,M10.5.0",
            "<-02>2<-01>,M3.5.0/-1,M10.5.0/0",
            "EST5EDT,M3.2.0/-1,M11.1.0",
            "EST5EDT,M3.2.0/167,M11.1.0",
            "EST5EDT,0/0,J365/25",
            "WART4WARST,J1/0,J365/25",
            "XYZ-24:59",
            "XYZ24",
            "EST5EDT",
            "EST5EDT,M3.2.0",
            "EST5EDT,M3.2.0,M11.1.0,",
            "EST5EDT,M13.2.0,M11.1.0",
            "EST5EDT,M3.6.0,M11.1.0",
            "EST5EDT,M3.2.7,M11.1.0",
            "EST5EDT,J0,J365",
            "EST5EDT,366,0",
            "EST5EDT,M3.2.0/1:60,M11.1.0",
            "EST5:60",
            "ES5",
            "ABCDEFGH5",
            "<A_B>5",
            "<-03>3<-02>,M3.5.0/-2,M10.5.0/-1",
        ] {
            assert_eq!(
                resolved(Some(rule), None, Some("Asia/Tokyo"), true, &nothing),
                9 * 60,
                "{rule}"
            );
        }
    }

    #[test]
    fn a_rule_chrono_read_is_read() {
        for (rule, minutes) in [
            ("EST5EDT,M3.2.0/24,M11.1.0", -5 * 60),
            ("EST5EDT,M3.2.0/0:30:59,M11.1.0", -5 * 60),
            ("EST5EDT,0/0,J365/24", -4 * 60),
            ("<+0530>-5:30", 5 * 60 + 30),
            ("XYZ-23:59:59", 23 * 60 + 59),
            (" EST5 ", -5 * 60),
            ("EST+5", -5 * 60),
        ] {
            assert_eq!(
                resolved(Some(rule), None, Some("Asia/Tokyo"), true, &nothing),
                minutes,
                "{rule}"
            );
        }
    }

    /// A `TZ` that names nothing falls to the platform's name, not to `/etc/localtime`.
    #[test]
    fn a_tz_that_does_not_read_falls_to_the_platform_name() {
        assert_eq!(
            resolved(
                Some(":Nowhere/At_All"),
                Some(LOCALTIME),
                Some("Asia/Tokyo"),
                true,
                &nothing
            ),
            9 * 60
        );
    }

    /// `TZ=localtime` reads `/etc/localtime`, as no `TZ` does, before any zone of that name.
    #[test]
    fn tz_localtime_reads_etc_localtime() {
        assert_eq!(
            resolved(
                Some("localtime"),
                Some(LOCALTIME),
                Some("Asia/Tokyo"),
                true,
                &plus_one
            ),
            5 * 60 + 30
        );
        assert_eq!(
            resolved(Some("localtime"), None, Some("Asia/Tokyo"), true, &plus_one),
            9 * 60
        );
    }

    #[test]
    fn without_tz_etc_localtime_wins_over_the_platform_name() {
        assert_eq!(
            resolved(None, Some(LOCALTIME), Some("Asia/Tokyo"), true, &plus_one),
            5 * 60 + 30
        );
    }

    /// Android: no `/etc/localtime`, so `persist.sys.timezone`'s name, in the updatable
    /// tzdata before the system's.
    #[test]
    fn the_platform_name_is_looked_up_in_the_updatable_tzdata_first() {
        assert_eq!(
            resolved(None, None, Some("Asia/Tokyo"), true, &plus_one),
            9 * 60
        );
        assert_eq!(
            resolved(None, None, Some("Asia/Tokyo"), false, &plus_one),
            60
        );
        assert_eq!(
            resolved(None, None, Some("Europe/Paris"), true, &plus_one),
            60
        );
    }

    #[test]
    fn nothing_found_is_utc() {
        assert_eq!(resolved(None, None, None, true, &nothing), 0);
        assert_eq!(
            resolved(
                None,
                Some(b"not tzif"),
                Some("Nowhere/At_All"),
                true,
                &nothing
            ),
            0
        );
    }

    #[test]
    fn the_updatable_tzdata_is_read_only_where_the_platform_names_it() {
        assert!(apex_db_under(None).is_none());
        assert!(apex_db_under(Some("/nonexistent".into())).is_none());
        assert!(apex().get("Asia/Kolkata").is_ok());
    }

    #[test]
    fn the_zone_is_looked_up_again_only_when_its_source_changed() {
        let tz = |value: &str| Source::Environment {
            value: value.to_string(),
        };
        let file = |seconds| Source::LocalTime {
            mtime: SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(seconds),
        };

        assert!(!needs_lookup(&tz("Asia/Tokyo"), &tz("Asia/Tokyo")));
        assert!(needs_lookup(&tz("Asia/Tokyo"), &tz("UTC")));
        assert!(!needs_lookup(&file(1), &file(1)));
        assert!(needs_lookup(&file(1), &file(2)));
        assert!(needs_lookup(&tz("UTC"), &file(1)));
    }

    /// Frozen from chrono 0.4.45's `Local.from_local_datetime(..).earliest()` under the same
    /// `TZ`. A wall clock a change skips names nothing, except the gap's first second, which
    /// chrono read in the offset before it. One the change repeats names the smaller offset,
    /// the one after the change: the later of the two instants, whatever `earliest` says.
    #[test]
    fn a_gap_and_a_fold_read_as_chrono_read_them() {
        let new_york = Zone::rules(TimeZone::posix("EST5EDT,M3.2.0,M11.1.0").unwrap());
        let at = |month, day, hour, minute, second| {
            new_york
                .earliest(WallClock::new(2026, month, day, hour, minute, second).unwrap())
                .map(|stamp| stamp.rfc3339())
        };

        assert_eq!(
            at(3, 8, 1, 59, 59).as_deref(),
            Some("2026-03-08T01:59:59-05:00")
        );
        assert_eq!(
            at(3, 8, 2, 0, 0).as_deref(),
            Some("2026-03-08T02:00:00-05:00")
        );
        assert_eq!(at(3, 8, 2, 0, 1), None);
        assert_eq!(at(3, 8, 2, 30, 0), None);
        assert_eq!(at(3, 8, 2, 59, 59), None);
        assert_eq!(
            at(3, 8, 3, 0, 0).as_deref(),
            Some("2026-03-08T03:00:00-04:00")
        );
        assert_eq!(
            at(11, 1, 0, 59, 59).as_deref(),
            Some("2026-11-01T00:59:59-04:00")
        );
        assert_eq!(
            at(11, 1, 1, 0, 0).as_deref(),
            Some("2026-11-01T01:00:00-05:00")
        );
        assert_eq!(
            at(11, 1, 1, 30, 0).as_deref(),
            Some("2026-11-01T01:30:00-05:00")
        );
        assert_eq!(
            at(11, 1, 1, 59, 59).as_deref(),
            Some("2026-11-01T01:59:59-05:00")
        );
        assert_eq!(
            at(11, 1, 2, 0, 0).as_deref(),
            Some("2026-11-01T02:00:00-05:00")
        );
        assert_eq!(
            at(1, 15, 12, 0, 0).as_deref(),
            Some("2026-01-15T12:00:00-05:00")
        );
    }

    /// chrono looked a wall clock up by its whole second, so a fraction into the gap's first
    /// second is still read before the change.
    #[test]
    fn a_fraction_does_not_move_a_wall_clock_into_the_gap() {
        let new_york = Zone::rules(TimeZone::posix("EST5EDT,M3.2.0,M11.1.0").unwrap());
        let wall = "2026-03-08T02:00:00.5-05:00"
            .parse::<Stamp>()
            .unwrap()
            .wall();

        assert_eq!(
            new_york
                .earliest(wall)
                .map(|stamp| stamp.rfc3339())
                .as_deref(),
            Some("2026-03-08T02:00:00.500-05:00")
        );
    }

    /// jiff reads offsets up to 25:59:59; a stamp holds less than a day, so a zone that
    /// puts more on an instant gives UTC's, and names no wall clock.
    #[test]
    fn an_offset_of_a_day_or_more_is_never_put_on_a_stamp() {
        let january = WallClock::new(2026, 1, 15, 0, 0, 0).unwrap();
        for rule in ["XYZ-24:59", "XYZ24"] {
            let zone = TimeZone::posix(rule).unwrap();

            assert_eq!(offset_at(&zone, january), 0, "{rule}");
            assert_eq!(Zone::rules(zone).earliest(january), None, "{rule}");
        }
    }

    #[test]
    fn a_leap_second_is_placed_by_its_second_59() {
        let new_york = Zone::rules(TimeZone::posix("EST5EDT,M3.2.0,M11.1.0").unwrap());
        let leap = "2026-12-31T23:59:60-05:00".parse::<Stamp>().unwrap().wall();

        assert_eq!(
            new_york
                .earliest(leap)
                .map(|stamp| stamp.rfc3339())
                .as_deref(),
            Some("2026-12-31T23:59:60-05:00")
        );
    }
}
