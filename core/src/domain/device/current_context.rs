//! The device state of right now, asked of the OS.

use super::context::{ClientContext, Context, Location, NetworkType, fill_from_client};
use crate::services::os::{self, Link, Reading};

/// A [`Context`] filled with only what the device can be asked about.
///
/// Items that could not be found are returned as `None`. On a platform like
/// Android, where neither power nor network is visible from native code, this is
/// the base that the `WebView` side is expected to fill in again.
#[must_use]
pub fn probe() -> Context {
    context_from(os::read())
}

/// What the device says of itself right now, with the gaps filled from what the `WebView`
/// (or the widget) could read; see [`fill_from_client`].
///
/// How the values are measured lives here rather than in the app, so that writes from
/// the CLI and MCP leave the same content. `fallback_location` is asked for coordinates
/// only when the client has none: the app passes the last macOS fix.
#[must_use]
pub fn probe_with_client<F>(client: ClientContext, fallback_location: F) -> Context
where
    F: FnOnce() -> Option<Location>,
{
    fill_from_client(probe(), client, fallback_location)
}

/// What a record keeps of an OS reading. The location is never in it: positioning
/// needs permission and waiting, and the side that can get coordinates adds them.
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

const fn network_type(link: Link) -> NetworkType {
    match link {
        Link::WiFi => NetworkType::WiFi,
        Link::Ethernet => NetworkType::Ethernet,
        Link::Mobile => NetworkType::Mobile,
        Link::Offline => NetworkType::Offline,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reading(link: Option<Link>) -> Reading {
        Reading {
            battery: Some(82),
            is_charging: Some(false),
            link,
            os: "macos".to_string(),
            os_version: Some("26.1".to_string()),
            arch: "aarch64".to_string(),
            hostname: Some("MacBook".to_string()),
            locale: Some("ja_JP".to_string()),
        }
    }

    /// The network type is written into the record by name, so each link has to land on
    /// the type of the same name.
    #[test]
    fn each_link_becomes_the_network_type_of_its_name() {
        for (link, network_type) in [
            (Link::WiFi, NetworkType::WiFi),
            (Link::Ethernet, NetworkType::Ethernet),
            (Link::Mobile, NetworkType::Mobile),
            (Link::Offline, NetworkType::Offline),
        ] {
            assert_eq!(
                context_from(reading(Some(link))).network_type,
                Some(network_type),
                "{link:?}"
            );
        }
    }

    /// A platform that cannot see the route (Android) says nothing rather than "offline":
    /// the `WebView` fills the gap in.
    #[test]
    fn an_unknown_link_stays_unknown() {
        assert_eq!(context_from(reading(None)).network_type, None);
    }

    #[test]
    fn a_reading_never_brings_a_location() {
        assert_eq!(context_from(reading(Some(Link::WiFi))).location, None);
        assert_eq!(context_from(reading(None)).location, None);
    }

    #[test]
    fn the_rest_of_the_reading_is_kept_as_it_is() {
        let context = context_from(reading(None));

        assert_eq!(context.battery, Some(82));
        assert_eq!(context.is_charging, Some(false));
        assert_eq!(context.os, "macos");
        assert_eq!(context.os_version.as_deref(), Some("26.1"));
        assert_eq!(context.arch, "aarch64");
        assert_eq!(context.hostname.as_deref(), Some("MacBook"));
        assert_eq!(context.locale.as_deref(), Some("ja_JP"));
    }

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

    /// The machine comes from the probe, the coordinates from the client.
    #[test]
    fn a_probe_with_the_client_keeps_the_machine_and_takes_the_coordinates() {
        let client = ClientContext {
            latitude: Some(35.68),
            longitude: Some(139.76),
            ..ClientContext::default()
        };

        let context = probe_with_client(client, || None);

        assert_eq!(context.os, std::env::consts::OS);
        assert_eq!(
            context.location,
            Some(Location {
                latitude: 35.68,
                longitude: 139.76
            })
        );
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
