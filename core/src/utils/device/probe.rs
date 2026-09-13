//! いまこの端末がどういう状態かを、OS に直接聞いて [`Context`] にする。
//!
//! アプリ・CLI・MCP のどこから書いても同じ内容が残るように、測り方は
//! ここ 1 か所に置く。入り口ごとに実装を持つと、同じ端末で書いた記録が
//! 入り口の違いだけで別物に見える。
//!
//! 位置情報だけはここに無い。測位は許可と待ち時間を伴い、常駐している
//! アプリと 1 回で終わる CLI とで取り方が変わる。要る側が足す。

use super::{Context, Location, NetworkType};

/// 端末に聞いて分かるぶんだけを埋めた [`Context`]。
///
/// 分からなかった項目は `None` のまま返す。Android のようにネイティブから
/// 電源もネットワークも見えない環境では、`WebView` 側の値で埋め直す
/// 前提の下地になる。
#[must_use]
pub fn probe() -> Context {
    let (battery, is_charging) = battery();

    Context {
        battery,
        is_charging,
        network_type: network(),
        location: None,
        os: std::env::consts::OS.to_string(),
        os_version: os_version(),
        arch: std::env::consts::ARCH.to_string(),
        hostname: hostname(),
        locale: locale(),
    }
}

/// 座標を 2 つ揃って渡されたときだけ [`Location`] にする。
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

/// Android の hostname は端末によらず "localhost" で、どの端末で書いたのかを
/// 何も語らない。記録する意味のない値なので落とす。
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

/// Linux は配布物ごとに版の付け方が違うので、`/etc/os-release` に聞く。
#[cfg(target_os = "linux")]
fn os_version() -> Option<String> {
    parse_os_release(&std::fs::read_to_string("/etc/os-release").ok()?)
}

/// `/etc/os-release` から「配布物の名前 + 版」を組む。
///
/// `os` は Linux ではただの "linux" で、版だけを足しても何の Linux か分からない。
/// 名前と並べて初めて、macOS の "26.6.2" と同じだけのことを語る。版を持たない
/// rolling release は `PRETTY_NAME` が名前だけを返すので、それをそのまま使う。
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

/// いま外に出ている経路が有線か無線かを、名前を聞かずに判定する。
///
/// 既定経路のインターフェース名を引き、それがどのハードウェアポートかを
/// 名前で引き直す。SSID を読むのと違い、どちらのコマンドも位置情報の許可を
/// 必要としない。
#[cfg(target_os = "macos")]
fn network() -> Option<NetworkType> {
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

/// Linux も既定経路から辿る。経路表は `/proc/net/route` がそのまま持っている
/// ので、`ip` を起動する必要はない。無線かどうかは `/sys` のマークが答える。
#[cfg(target_os = "linux")]
fn network() -> Option<NetworkType> {
    let route = std::fs::read_to_string("/proc/net/route").ok()?;
    let Some(interface) = parse_default_route_interface(&route) else {
        // 既定経路が無い = どこにも出られない。
        return Some(NetworkType::Offline);
    };

    let device = std::path::Path::new("/sys/class/net").join(&interface);
    let wireless = device.join("wireless").exists() || device.join("phy80211").exists();

    Some(classify_interface(&interface, wireless))
}

/// `/proc/net/route` の、宛先が `00000000` の行のインターフェース名。
///
/// 1 行目は見出しなので読み飛ばす。
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_default_route_interface(contents: &str) -> Option<String> {
    contents.lines().skip(1).find_map(|line| {
        let mut fields = line.split_whitespace();
        let interface = fields.next()?;
        (fields.next()? == "00000000").then(|| interface.to_string())
    })
}

/// インターフェース名と `/sys` の無線マークから回線の種類を決める。
///
/// USB テザリングは Linux では `usb0` や `enp0s20u1` として現れ、机の上の
/// 有線と見分けが付かない。macOS のようにハードウェアポートの名前を引けない
/// ので、携帯回線と言い切れるのは専用の接頭辞を持つものだけ。
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn classify_interface(interface: &str, wireless: bool) -> NetworkType {
    const MOBILE_PREFIXES: [&str; 4] = ["wwan", "wwp", "ppp", "rmnet"];

    if wireless {
        NetworkType::WiFi
    } else if MOBILE_PREFIXES
        .iter()
        .any(|prefix| interface.starts_with(prefix))
    {
        NetworkType::Mobile
    } else {
        NetworkType::Ethernet
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
const fn network() -> Option<NetworkType> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// どの OS でも名乗れる 2 つ。ここが空だと、どの端末で書いたのかを
    /// 記録が一切語らなくなる。
    #[test]
    fn always_names_the_machine_it_ran_on() {
        let context = probe();

        assert!(!context.os.is_empty());
        assert!(!context.arch.is_empty());
    }

    /// 測位はしない。許可も待ち時間も要らない範囲がここの担当で、
    /// 座標は取れる入り口が後から足す。
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
}

#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
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

    /// macOS は `sw_vers` を持っているので、版まで名乗れる。
    #[test]
    fn names_the_os_version_on_macos() {
        assert!(probe().os_version.is_some());
    }
}

/// Linux 側の読み取りのうち、ファイルの中身を解くところだけを取り出したもの。
///
/// 呼ぶのは Linux のビルドだけだが、全プラットフォームでビルドしてテストする。
/// 手元も CI の macOS ジョブも Linux ではなく、`cfg` で閉じると誰も実行しない
/// テストになる。ファイルを開く側と違い、ここは中身さえあれば検証できる。
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

    /// `os` が "linux" としか言わないので、版だけでは何の Linux か分からない。
    /// 名前と版を組にして初めて、macOS の "26.6.2" と同じ重さの記録になる。
    #[test]
    fn names_the_distribution_and_its_version() {
        assert_eq!(parse_os_release(UBUNTU).as_deref(), Some("Ubuntu 24.04"));
        assert_eq!(parse_os_release(NIXOS).as_deref(), Some("NixOS 25.05"));
    }

    /// 版を持たない rolling release は名前だけで名乗る。
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

    /// `/proc/net/route` の抜粋。既定経路は宛先が 00000000 の行。
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

    /// 既定経路の行が無い = どこにも出られない。
    #[test]
    fn finds_no_interface_without_a_default_route() {
        let only_lan = "Iface\tDestination\tGateway\n\
            enp0s3\t0002A8C0\t00000000\n";

        assert_eq!(parse_default_route_interface(only_lan), None);
        assert_eq!(parse_default_route_interface(""), None);
    }

    /// 実機の Linux で読める場所を見ているかは、パースのテストでは分からない。
    /// CI の Linux ジョブが通る唯一の確認。
    #[cfg(target_os = "linux")]
    #[test]
    fn names_the_distribution_it_runs_on() {
        assert!(probe().os_version.is_some());
    }

    /// 無線かどうかは名前ではなく `/sys` が答える。名前で見分けるのは
    /// 携帯回線のインターフェースだけで、そちらは慣習の接頭辞しか手がかりが無い。
    #[test]
    fn tells_wireless_from_wired() {
        assert_eq!(classify_interface("wlp2s0", true), NetworkType::WiFi);
        assert_eq!(classify_interface("enp0s3", false), NetworkType::Ethernet);
        assert_eq!(classify_interface("wwan0", false), NetworkType::Mobile);
        assert_eq!(classify_interface("ppp0", false), NetworkType::Mobile);
    }
}
