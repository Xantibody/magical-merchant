//! Asks the OS directly what state this device is in.
//!
//! The measuring lives in this one place so that the same content is recorded
//! whether written from the app, the CLI or MCP. With one implementation per
//! entry point, records written on the same device would look different just
//! because of the entry point.
//!
//! Only the location is not here. Positioning involves permission and waiting,
//! and a resident app and a one-shot CLI obtain it differently. The side that
//! needs it adds it.
//!
//! The answer is in the OS's own terms ([`Reading`], [`Link`]); what a record keeps of it
//! is decided in `domain::device`.

/// What the OS answered. Items it could not tell are `None`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reading {
    pub battery: Option<u8>,
    pub is_charging: Option<bool>,
    pub link: Option<Link>,
    pub os: String,
    pub os_version: Option<String>,
    pub arch: String,
    pub hostname: Option<String>,
    pub locale: Option<String>,
}

/// How the default route leaves the device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Link {
    WiFi,
    Ethernet,
    Mobile,
    /// No default route: no way out.
    Offline,
}

/// Asks the OS about everything it can tell without permission or waiting.
#[must_use]
pub fn read() -> Reading {
    let (battery, is_charging) = battery();

    Reading {
        battery,
        is_charging,
        link: network(),
        os: std::env::consts::OS.to_string(),
        os_version: os_version(),
        arch: std::env::consts::ARCH.to_string(),
        hostname: hostname(),
        locale: locale(),
    }
}

/// On Android the hostname is "localhost" on every device and says nothing about
/// which device wrote the record. The value is not worth recording, so it is dropped.
fn hostname() -> Option<String> {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .filter(|h| h != "localhost")
}

#[cfg(target_os = "macos")]
fn os_version() -> Option<String> {
    let output = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

/// Linux versions differently per distribution, so `/etc/os-release` is asked.
#[cfg(target_os = "linux")]
fn os_version() -> Option<String> {
    parse_os_release(&std::fs::read_to_string("/etc/os-release").ok()?)
}

/// Builds "distribution name + version" from `/etc/os-release`.
///
/// On Linux `os` is just "linux", and adding only the version does not say which
/// Linux. Only next to the name does it say as much as "26.6.2" does on macOS. A
/// rolling release without a version gets only the name from `PRETTY_NAME`, and
/// that is used as is.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_os_release(contents: &str) -> Option<String> {
    fn field(contents: &str, key: &str) -> Option<String> {
        contents.lines().find_map(|line| {
            let value = line.strip_prefix(key)?.strip_prefix('=')?;
            let value = value.trim().trim_matches('"').trim();
            (!value.is_empty()).then(|| value.to_string())
        })
    }

    match (field(contents, "NAME"), field(contents, "VERSION_ID")) {
        (Some(name), Some(version)) => Some(format!("{name} {version}")),
        _ => field(contents, "PRETTY_NAME"),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
const fn os_version() -> Option<String> {
    None
}

fn locale() -> Option<String> {
    std::env::var("LC_ALL")
        .or_else(|_| std::env::var("LANG"))
        .ok()
        .map(|l| l.split('.').next().unwrap_or(&l).to_string())
}

#[cfg(not(target_os = "android"))]
fn battery() -> (Option<u8>, Option<bool>) {
    use battery::State;

    let Ok(manager) = battery::Manager::new() else {
        return (None, None);
    };

    let Ok(mut batteries) = manager.batteries() else {
        return (None, None);
    };

    match batteries.next() {
        Some(Ok(bat)) => {
            // clamp() keeps the value inside u8 range, so the cast cannot
            // truncate or lose a sign.
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let percentage = (bat.state_of_charge().value * 100.0)
                .round()
                .clamp(0.0, 100.0) as u8;
            let charging = matches!(bat.state(), State::Charging | State::Full);
            (Some(percentage), Some(charging))
        }
        _ => (None, None),
    }
}

#[cfg(target_os = "android")]
const fn battery() -> (Option<u8>, Option<bool>) {
    (None, None)
}

/// Decides whether the current outbound route is wired or wireless, without asking
/// for a network name.
///
/// Looks up the interface name of the default route, then looks up by name which
/// hardware port it is. Unlike reading the SSID, neither command needs the location
/// permission.
#[cfg(target_os = "macos")]
fn network() -> Option<Link> {
    let route = std::process::Command::new("route")
        .args(["-n", "get", "default"])
        .output()
        .ok()?;
    let Some(interface) = parse_default_interface(&String::from_utf8_lossy(&route.stdout)) else {
        // no default route = no way out.
        return Some(Link::Offline);
    };

    let ports = std::process::Command::new("networksetup")
        .arg("-listallhardwareports")
        .output()
        .ok()?;
    let port = parse_hardware_port(&String::from_utf8_lossy(&ports.stdout), &interface)?;

    Some(classify_port(&port))
}

/// The `interface:` line of `route -n get default`.
#[cfg(target_os = "macos")]
fn parse_default_interface(stdout: &str) -> Option<String> {
    stdout.lines().find_map(|line| {
        let name = line.trim().strip_prefix("interface: ")?.trim();
        (!name.is_empty()).then(|| name.to_string())
    })
}

/// Returns, from `networksetup -listallhardwareports`, the name of the
/// `Hardware Port` that has that `Device`. A port name and its Device line always
/// pair up in this order.
#[cfg(target_os = "macos")]
fn parse_hardware_port(stdout: &str, interface: &str) -> Option<String> {
    let mut port: Option<&str> = None;
    for line in stdout.lines() {
        let line = line.trim();
        if let Some(name) = line.strip_prefix("Hardware Port: ") {
            port = Some(name.trim());
        } else if let Some(device) = line.strip_prefix("Device: ") {
            if device.trim() == interface {
                return port.map(str::to_string);
            }
        }
    }
    None
}

/// Decides the kind of connection from the port name.
///
/// USB tethering to an iPhone looks wired, but the traffic goes out over the
/// mobile network. Recorded as wired, a record that could only be written where
/// there was signal would look as if it was written at a desk.
#[cfg(target_os = "macos")]
fn classify_port(port: &str) -> Link {
    let lowered = port.to_lowercase();
    if lowered.contains("wi-fi") || lowered.contains("airport") {
        Link::WiFi
    } else if lowered.contains("iphone") || lowered.contains("ipad") {
        Link::Mobile
    } else {
        Link::Ethernet
    }
}

/// Linux also starts from the default route. `/proc/net/route` holds the routing
/// table as is, so there is no need to launch `ip`. Whether it is wireless is
/// answered by the marker in `/sys`.
#[cfg(target_os = "linux")]
fn network() -> Option<Link> {
    let route = std::fs::read_to_string("/proc/net/route").ok()?;
    let Some(interface) = parse_default_route_interface(&route) else {
        // no default route = no way out.
        return Some(Link::Offline);
    };

    let device = std::path::Path::new("/sys/class/net").join(&interface);
    let wireless = device.join("wireless").exists() || device.join("phy80211").exists();

    Some(classify_interface(&interface, wireless))
}

/// The interface name on the `/proc/net/route` line whose destination is `00000000`.
///
/// The first line is a header and is skipped.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_default_route_interface(contents: &str) -> Option<String> {
    contents.lines().skip(1).find_map(|line| {
        let mut fields = line.split_whitespace();
        let interface = fields.next()?;
        (fields.next()? == "00000000").then(|| interface.to_string())
    })
}

/// Decides the kind of connection from the interface name and the wireless marker in `/sys`.
///
/// On Linux, USB tethering shows up as `usb0` or `enp0s20u1` and cannot be told
/// from the wired connection at a desk. The hardware port name cannot be looked
/// up as on macOS, so only interfaces with a dedicated prefix can be called mobile
/// with certainty.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn classify_interface(interface: &str, wireless: bool) -> Link {
    const MOBILE_PREFIXES: [&str; 4] = ["wwan", "wwp", "ppp", "rmnet"];

    if wireless {
        Link::WiFi
    } else if MOBILE_PREFIXES
        .iter()
        .any(|prefix| interface.starts_with(prefix))
    {
        Link::Mobile
    } else {
        Link::Ethernet
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
const fn network() -> Option<Link> {
    None
}

#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use super::*;

    /// An excerpt of `networksetup -listallhardwareports` from a real machine.
    const PORTS: &str = "\n\
        Hardware Port: Ethernet Adapter (en3)\n\
        Device: en3\n\
        Ethernet Address: 32:73:6f:a1:60:43\n\
        \n\
        Hardware Port: Thunderbolt Bridge\n\
        Device: bridge0\n\
        Ethernet Address: 36:c3:1a:6d:54:00\n\
        \n\
        Hardware Port: Wi-Fi\n\
        Device: en0\n\
        Ethernet Address: 10:9f:41:bf:3d:ff\n";

    #[test]
    fn reads_the_interface_the_default_route_uses() {
        let stdout = "   route to: default\n    gateway: 192.168.3.1\n  interface: en0\n";

        assert_eq!(parse_default_interface(stdout).as_deref(), Some("en0"));
    }

    /// Without a default route, `route` does not print this line.
    #[test]
    fn finds_no_interface_without_a_default_route() {
        assert_eq!(
            parse_default_interface("route: writing to routing socket: not in table"),
            None
        );
    }

    #[test]
    fn matches_an_interface_to_its_hardware_port() {
        assert_eq!(parse_hardware_port(PORTS, "en0").as_deref(), Some("Wi-Fi"));
        assert_eq!(
            parse_hardware_port(PORTS, "en3").as_deref(),
            Some("Ethernet Adapter (en3)")
        );
    }

    #[test]
    fn finds_no_port_for_an_interface_that_is_not_listed() {
        assert_eq!(parse_hardware_port(PORTS, "utun4"), None);
    }

    #[test]
    fn tells_wireless_from_wired() {
        assert_eq!(classify_port("Wi-Fi"), Link::WiFi);
        assert_eq!(classify_port("AirPort"), Link::WiFi);
        assert_eq!(classify_port("Ethernet Adapter (en3)"), Link::Ethernet);
        assert_eq!(classify_port("Thunderbolt Bridge"), Link::Ethernet);
    }

    /// Even plugged in over USB, the traffic goes out over the mobile network. Recorded
    /// as wired, a record that could only be written where there was signal would look
    /// as if it was written at a desk.
    #[test]
    fn counts_a_tethered_phone_as_mobile() {
        assert_eq!(classify_port("iPhone USB"), Link::Mobile);
    }
}

/// The part of the Linux readers that only decodes file contents, taken out on its own.
///
/// Only the Linux build calls it, but it is built and tested on every platform.
/// Neither the local machine nor the CI macOS job is Linux, and closing it behind
/// `cfg` would make a test nobody runs. Unlike the side that opens files, this can
/// be verified with the contents alone.
#[cfg(test)]
mod linux_tests {
    use super::*;

    const UBUNTU: &str = r#"PRETTY_NAME="Ubuntu 24.04.1 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04.1 LTS (Noble Numbat)"
ID=ubuntu
"#;

    const NIXOS: &str = r#"NAME=NixOS
ID=nixos
VERSION="25.05 (Warbler)"
VERSION_ID="25.05"
PRETTY_NAME="NixOS 25.05 (Warbler)"
"#;

    /// `os` says only "linux", so the version alone does not say which Linux.
    /// Only the name paired with the version makes a record as weighty as "26.6.2" on macOS.
    #[test]
    fn names_the_distribution_and_its_version() {
        assert_eq!(parse_os_release(UBUNTU).as_deref(), Some("Ubuntu 24.04"));
        assert_eq!(parse_os_release(NIXOS).as_deref(), Some("NixOS 25.05"));
    }

    /// A rolling release without a version names itself by name alone.
    #[test]
    fn falls_back_to_the_pretty_name_without_a_version() {
        let arch = "NAME=\"Arch Linux\"\nPRETTY_NAME=\"Arch Linux\"\nID=arch\n";

        assert_eq!(parse_os_release(arch).as_deref(), Some("Arch Linux"));
    }

    #[test]
    fn finds_no_version_in_an_empty_or_unreadable_file() {
        assert_eq!(parse_os_release(""), None);
        assert_eq!(parse_os_release("ID=ubuntu\n"), None);
    }

    /// An excerpt of `/proc/net/route`. The default route is the line whose destination
    /// is 00000000.
    const ROUTE: &str = "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\n\
        enp0s3\t0002A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\n\
        wlp2s0\t00000000\t0102A8C0\t0003\t0\t0\t600\t00000000\n";

    #[test]
    fn reads_the_interface_the_default_route_uses() {
        assert_eq!(
            parse_default_route_interface(ROUTE).as_deref(),
            Some("wlp2s0")
        );
    }

    /// No default route line = no way out.
    #[test]
    fn finds_no_interface_without_a_default_route() {
        let only_lan = "Iface\tDestination\tGateway\n\
            enp0s3\t0002A8C0\t00000000\n";

        assert_eq!(parse_default_route_interface(only_lan), None);
        assert_eq!(parse_default_route_interface(""), None);
    }

    /// Whether it is wireless is answered by `/sys`, not the name. Only mobile
    /// interfaces are told by name, and for those the conventional prefix is the only clue.
    #[test]
    fn tells_wireless_from_wired() {
        assert_eq!(classify_interface("wlp2s0", true), Link::WiFi);
        assert_eq!(classify_interface("enp0s3", false), Link::Ethernet);
        assert_eq!(classify_interface("wwan0", false), Link::Mobile);
        assert_eq!(classify_interface("ppp0", false), Link::Mobile);
    }
}
