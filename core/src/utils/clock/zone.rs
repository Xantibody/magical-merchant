use chrono::{FixedOffset, Local, TimeZone as _};

use super::civil::WallClock;
use super::stamp::Stamp;

/// Where a wall clock is read: the device's zone, or a fixed offset.
///
/// A caller that turns a wall clock into an instant takes one, so a test can name the
/// zone instead of depending on the machine it runs on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Zone(Kind);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Local,
    Fixed(FixedOffset),
}

impl Zone {
    /// The device's zone.
    #[must_use]
    pub const fn local() -> Self {
        Self(Kind::Local)
    }

    /// `offset_seconds` east of UTC all year round. `None` for a day or more.
    #[must_use]
    pub fn fixed(offset_seconds: i32) -> Option<Self> {
        FixedOffset::east_opt(offset_seconds).map(|offset| Self(Kind::Fixed(offset)))
    }

    /// The instant this wall clock names here, in the offset in force then. A wall clock a
    /// clock change skips over names none; one it repeats names the earlier of the two.
    #[must_use]
    pub fn earliest(&self, wall: WallClock) -> Option<Stamp> {
        let naive = wall.inner();
        match self.0 {
            Kind::Local => Local
                .from_local_datetime(&naive)
                .earliest()
                .map(|local| Stamp::from_inner(local.fixed_offset())),
            Kind::Fixed(offset) => offset
                .from_local_datetime(&naive)
                .earliest()
                .map(Stamp::from_inner),
        }
    }
}
