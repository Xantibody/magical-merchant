use magical_merchant_core::DeviceContext;
use magical_merchant_core::utils::device::{Location, NetworkType};
use serde::Deserialize;

/// `WebView` 側で集めた実行環境。Android には `battery` クレートの実装も
/// `SystemConfiguration` も無く、ネイティブからは電源もネットワークも一切見えない。
/// 取れる側から埋めるための入力で、`None` は「そちらでは分からなかった」を意味する。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct ClientContext {
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub battery: Option<u8>,
    pub is_charging: Option<bool>,
    pub network_type: Option<NetworkType>,
    pub os_version: Option<String>,
    pub locale: Option<String>,
}

/// ネイティブで取れた値を優先し、空いたところだけ `WebView` 側の値で埋める。
/// ネイティブは OS に直接聞ける（macOS の battery クレートなど）ぶん確度が高い。
pub(crate) fn get_context(client: ClientContext) -> DeviceContext {
    let (battery, is_charging) = get_battery();

    DeviceContext {
        battery: battery.or(client.battery),
        is_charging: is_charging.or(client.is_charging),
        network_type: get_network().or(client.network_type),
        location: make_location(client.latitude, client.longitude).or_else(get_location),
        os: std::env::consts::OS.to_string(),
        os_version: get_os_version().or(client.os_version),
        arch: std::env::consts::ARCH.to_string(),
        hostname: get_hostname(),
        locale: get_locale().or(client.locale),
    }
}

/// `WebView` が座標を持たないときの取り直し。Android の geolocation プラグインは
/// フロント側で答えを出しているので、こちらが要るのは macOS だけ。
#[cfg(target_os = "macos")]
fn get_location() -> Option<Location> {
    crate::location::latest()
}

#[cfg(not(target_os = "macos"))]
const fn get_location() -> Option<Location> {
    None
}

const fn make_location(latitude: Option<f64>, longitude: Option<f64>) -> Option<Location> {
    match (latitude, longitude) {
        (Some(latitude), Some(longitude)) => Some(Location {
            latitude,
            longitude,
        }),
        _ => None,
    }
}

/// Android の hostname は端末によらず "localhost" で、どの端末で書いたのかを
/// 何も語らない。記録する意味のない値なので落とす。
fn get_hostname() -> Option<String> {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .filter(|h| h != "localhost")
}

#[cfg(target_os = "macos")]
fn get_os_version() -> Option<String> {
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

#[cfg(not(target_os = "macos"))]
const fn get_os_version() -> Option<String> {
    None
}

fn get_locale() -> Option<String> {
    std::env::var("LC_ALL")
        .or_else(|_| std::env::var("LANG"))
        .ok()
        .map(|l| l.split('.').next().unwrap_or(&l).to_string())
}

#[cfg(not(target_os = "android"))]
fn get_battery() -> (Option<u8>, Option<bool>) {
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
const fn get_battery() -> (Option<u8>, Option<bool>) {
    (None, None)
}

/// いま外に出ている経路が有線か無線かを、名前を聞かずに判定する。
///
/// 既定経路のインターフェース名を引き、それがどのハードウェアポートかを
/// 名前で引き直す。SSID を読むのと違い、どちらのコマンドも位置情報の許可を
/// 必要としない。
#[cfg(target_os = "macos")]
fn get_network() -> Option<NetworkType> {
    let route = std::process::Command::new("route")
        .args(["-n", "get", "default"])
        .output()
        .ok()?;
    let Some(interface) = parse_default_interface(&String::from_utf8_lossy(&route.stdout)) else {
        // 既定経路が無い = どこにも出られない。
        return Some(NetworkType::Offline);
    };

    let ports = std::process::Command::new("networksetup")
        .arg("-listallhardwareports")
        .output()
        .ok()?;
    let port = parse_hardware_port(&String::from_utf8_lossy(&ports.stdout), &interface)?;

    Some(classify_port(&port))
}

/// `route -n get default` の `interface:` 行。
#[cfg(target_os = "macos")]
fn parse_default_interface(stdout: &str) -> Option<String> {
    stdout.lines().find_map(|line| {
        let name = line.trim().strip_prefix("interface: ")?.trim();
        (!name.is_empty()).then(|| name.to_string())
    })
}

/// `networksetup -listallhardwareports` から、その `Device` を持つ
/// `Hardware Port` の名前を返す。ポート名と Device 行は必ずこの順で対になる。
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

/// ポート名から回線の種類を決める。
///
/// iPhone の USB テザリングは見た目こそ有線だが、出ていく先は携帯回線。
/// 有線として記録すると、実際には電波の届く所でしか書けなかった記録が
/// 机の上で書いたように見える。
#[cfg(target_os = "macos")]
fn classify_port(port: &str) -> NetworkType {
    let lowered = port.to_lowercase();
    if lowered.contains("wi-fi") || lowered.contains("airport") {
        NetworkType::WiFi
    } else if lowered.contains("iphone") || lowered.contains("ipad") {
        NetworkType::Mobile
    } else {
        NetworkType::Ethernet
    }
}

#[cfg(not(target_os = "macos"))]
const fn get_network() -> Option<NetworkType> {
    None
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    /// 実機の `networksetup -listallhardwareports` の抜粋。
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

    /// 既定経路が無いときの `route` はこの行を出さない。
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
        assert_eq!(classify_port("Wi-Fi"), NetworkType::WiFi);
        assert_eq!(classify_port("AirPort"), NetworkType::WiFi);
        assert_eq!(
            classify_port("Ethernet Adapter (en3)"),
            NetworkType::Ethernet
        );
        assert_eq!(classify_port("Thunderbolt Bridge"), NetworkType::Ethernet);
    }

    /// USB で挿していても出ていく先は携帯回線。有線として記録すると、
    /// 電波の届く所でしか書けなかった記録が机の上で書いたように見える。
    #[test]
    fn counts_a_tethered_phone_as_mobile() {
        assert_eq!(classify_port("iPhone USB"), NetworkType::Mobile);
    }
}
