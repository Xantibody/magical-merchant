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
    let (network_type, wifi_ssid) = get_network();

    DeviceContext {
        battery: battery.or(client.battery),
        is_charging: is_charging.or(client.is_charging),
        network_type: network_type.or(client.network_type),
        wifi_ssid,
        location: make_location(client.latitude, client.longitude),
        os: std::env::consts::OS.to_string(),
        os_version: get_os_version().or(client.os_version),
        arch: std::env::consts::ARCH.to_string(),
        hostname: get_hostname(),
        locale: get_locale().or(client.locale),
    }
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

#[cfg(target_os = "macos")]
fn get_network() -> (Option<NetworkType>, Option<String>) {
    let Ok(output) = std::process::Command::new("ipconfig")
        .args(["getsummary", "en0"])
        .output()
    else {
        return (None, None);
    };

    parse_wifi_summary(&String::from_utf8_lossy(&output.stdout))
}

/// `ipconfig getsummary en0` の出力から Wi-Fi の状態を読む。
///
/// SSID 行があるだけで Wi-Fi 接続中だと分かるので、名前が読めなくても
/// `NetworkType::WiFi` は返す。macOS 14 以降は位置情報の許可がないと
/// SSID が `<redacted>` に伏せられ、これをそのまま保存すると
/// 「SSID が取れている」ように見えるゴミが記録に残る。
#[cfg(target_os = "macos")]
fn parse_wifi_summary(stdout: &str) -> (Option<NetworkType>, Option<String>) {
    for line in stdout.lines() {
        let Some(ssid) = line.trim().strip_prefix("SSID : ") else {
            continue;
        };
        let ssid = ssid.trim();
        if ssid.is_empty() {
            continue;
        }
        let named = (!is_redacted(ssid)).then(|| ssid.to_string());
        return (Some(NetworkType::WiFi), named);
    }

    // SSID 行がない = Ethernet かテザリングか本当に圏外。切り分けられない以上、
    // Offline と断定すると嘘になるので None のままにする。
    (None, None)
}

#[cfg(target_os = "macos")]
fn is_redacted(value: &str) -> bool {
    value.starts_with('<') && value.ends_with('>')
}

#[cfg(not(any(target_os = "macos", target_os = "android")))]
const fn get_network() -> (Option<NetworkType>, Option<String>) {
    (None, None)
}

#[cfg(target_os = "android")]
const fn get_network() -> (Option<NetworkType>, Option<String>) {
    (None, None)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    const CONNECTED: &str = "  <dictionary> {\n  BSSID : 11:22:33:44:55:66\n  SSID : MyNetwork\n}";

    #[test]
    fn reads_the_ssid_when_macos_discloses_it() {
        let (network, ssid) = parse_wifi_summary(CONNECTED);

        assert_eq!(network, Some(NetworkType::WiFi));
        assert_eq!(ssid.as_deref(), Some("MyNetwork"));
    }

    #[test]
    fn keeps_wifi_but_drops_the_name_when_macos_redacts_it() {
        let (network, ssid) = parse_wifi_summary("  BSSID : <redacted>\n  SSID : <redacted>");

        assert_eq!(network, Some(NetworkType::WiFi));
        assert_eq!(ssid, None);
    }

    #[test]
    fn reports_nothing_without_an_ssid_line() {
        let (network, ssid) = parse_wifi_summary("  <dictionary> {\n  IPv4 : 192.168.0.2\n}");

        assert_eq!(network, None);
        assert_eq!(ssid, None);
    }

    #[test]
    fn skips_an_empty_ssid_line() {
        let (network, ssid) = parse_wifi_summary("  SSID : \n");

        assert_eq!(network, None);
        assert_eq!(ssid, None);
    }
}
