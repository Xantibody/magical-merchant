use magical_merchant_core::DeviceContext;
use magical_merchant_core::utils::device::{self, Location, NetworkType};
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
///
/// 測り方そのものは core (`utils::device::probe`) にある。CLI と MCP から
/// 書いても同じ内容が残るように、アプリだけが持つ実装にはしない。
pub(crate) fn get_context(client: ClientContext) -> DeviceContext {
    let native = device::probe();

    DeviceContext {
        battery: native.battery.or(client.battery),
        is_charging: native.is_charging.or(client.is_charging),
        network_type: native.network_type.or(client.network_type),
        location: device::location(client.latitude, client.longitude).or_else(get_location),
        os: native.os,
        os_version: native.os_version.or(client.os_version),
        arch: native.arch,
        hostname: native.hostname,
        locale: native.locale.or(client.locale),
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

/// ウィジェットが JSON 1 本で渡してくる実行環境。
///
/// `WebView` の無い経路なので構造体をそのまま渡せず、JNI の文字列に詰めて
/// もらう。読めなければ既定値、つまり「何も分からなかった」に倒す。ここで
/// 失敗させても打った文が消えるだけで、メタデータが無くてもキャプチャの
/// 保存そのものは成立する。
///
/// 呼ぶのは Android の JNI ブリッジだけだが、ここに置いて全プラットフォームで
/// ビルドする。CI に Android ターゲットは無く、テストする値打ちがあるのは
/// パースの部分だから。
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn parse_client_context(json: &str) -> ClientContext {
    serde_json::from_str(json).unwrap_or_default()
}

#[cfg(test)]
mod client_context_tests {
    use super::*;

    #[test]
    fn reads_every_field_the_widget_can_fill() {
        let client = parse_client_context(
            r#"{"latitude":35.68,"longitude":139.76,"battery":42,"isCharging":true,
                "networkType":"WiFi","osVersion":"16","locale":"ja_JP"}"#,
        );

        assert_eq!(client.latitude, Some(35.68));
        assert_eq!(client.longitude, Some(139.76));
        assert_eq!(client.battery, Some(42));
        assert_eq!(client.is_charging, Some(true));
        assert_eq!(client.network_type, Some(NetworkType::WiFi));
        assert_eq!(client.os_version.as_deref(), Some("16"));
        assert_eq!(client.locale.as_deref(), Some("ja_JP"));
    }

    /// 位置情報だけは許可が下りていないことがある。欠けたキーは
    /// 「分からなかった」であって、保存の失敗ではない。
    #[test]
    fn leaves_absent_keys_unknown() {
        let client = parse_client_context(r#"{"battery":7,"networkType":"Offline"}"#);

        assert_eq!(client.battery, Some(7));
        assert_eq!(client.network_type, Some(NetworkType::Offline));
        assert_eq!(client.latitude, None);
        assert_eq!(client.longitude, None);
        assert_eq!(client.os_version, None);
    }

    #[test]
    fn falls_back_to_unknown_when_the_json_is_unreadable() {
        for json in ["", "{", "null", "[]"] {
            let client = parse_client_context(json);

            assert_eq!(client.battery, None, "{json}");
            assert_eq!(client.network_type, None, "{json}");
            assert_eq!(client.locale, None, "{json}");
        }
    }

    /// ネイティブが何も言えない項目を、クライアント側の値で埋める。
    /// Android はこれが無いと電池もネットワークも空のまま残る。
    #[test]
    fn fills_what_the_native_side_cannot_see_from_the_client() {
        let client = parse_client_context(
            r#"{"latitude":35.68,"longitude":139.76,"battery":42,"isCharging":true,
                "networkType":"Mobile","osVersion":"16","locale":"ja_JP"}"#,
        );

        let context = get_context(client);

        assert_eq!(context.os, std::env::consts::OS);
        assert_eq!(
            context.location,
            Some(Location {
                latitude: 35.68,
                longitude: 139.76
            })
        );
        assert!(context.battery.is_some());
        assert!(context.network_type.is_some());
        assert!(context.os_version.is_some());
    }
}
