//! Where and with what a record was written.

#[cfg(feature = "device-probe")]
use crate::services::os::{self, Link, Reading};
#[cfg(feature = "device-probe")]
use crate::utils::device::{Context, Location, NetworkType};

/// A [`Context`] filled with only what the device can be asked about.
///
/// Items that could not be found are returned as `None`. On a platform like
/// Android, where neither power nor network is visible from native code, this is
/// the base that the `WebView` side is expected to fill in again.
#[cfg(feature = "device-probe")]
#[must_use]
pub fn probe() -> Context {
    context_from(os::read())
}

/// What a record keeps of an OS reading. The location is never in it: positioning
/// needs permission and waiting, and the side that can get coordinates adds them.
#[cfg(feature = "device-probe")]
pub(crate) fn context_from(reading: Reading) -> Context {
    Context {
        battery: reading.battery,
        is_charging: reading.is_charging,
        network_type: reading.link.map(network_type),
        location: None,
        os: reading.os,
        os_version: reading.os_version,
        arch: reading.arch,
        hostname: reading.hostname,
        locale: reading.locale,
    }
}

#[cfg(feature = "device-probe")]
const fn network_type(link: Link) -> NetworkType {
    match link {
        Link::WiFi => NetworkType::WiFi,
        Link::Ethernet => NetworkType::Ethernet,
        Link::Mobile => NetworkType::Mobile,
        Link::Offline => NetworkType::Offline,
    }
}

/// Makes a [`Location`] only when both coordinates are passed together.
#[cfg(feature = "device-probe")]
#[must_use]
pub const fn location(latitude: Option<f64>, longitude: Option<f64>) -> Option<Location> {
    match (latitude, longitude) {
        (Some(latitude), Some(longitude)) => Some(Location {
            latitude,
            longitude,
        }),
        _ => None,
    }
}

#[cfg(all(test, feature = "device-probe"))]
mod tests {
    use super::*;

    /// The two that every OS can name. If these were empty, the record would say
    /// nothing at all about which device wrote it.
    #[test]
    fn always_names_the_machine_it_ran_on() {
        let context = probe();

        assert!(!context.os.is_empty());
        assert!(!context.arch.is_empty());
    }

    /// No positioning. What needs neither permission nor waiting is the job here;
    /// an entry point that can get coordinates adds them afterwards.
    #[test]
    fn leaves_the_location_to_the_caller() {
        assert!(probe().location.is_none());
    }

    #[test]
    fn makes_a_location_only_from_a_pair() {
        assert_eq!(
            location(Some(35.68), Some(139.76)),
            Some(Location {
                latitude: 35.68,
                longitude: 139.76
            })
        );
        assert_eq!(location(Some(35.68), None), None);
        assert_eq!(location(None, Some(139.76)), None);
        assert_eq!(location(None, None), None);
    }

    /// macOS has `sw_vers`, so it can name the version too.
    #[cfg(target_os = "macos")]
    #[test]
    fn names_the_os_version_on_macos() {
        assert!(probe().os_version.is_some());
    }

    /// A parsing test cannot tell whether a readable location on real Linux is being
    /// looked at. The CI Linux job passing is the only check.
    #[cfg(target_os = "linux")]
    #[test]
    fn names_the_distribution_it_runs_on() {
        assert!(probe().os_version.is_some());
    }
}
