use magical_merchant_core::DeviceContext;
use magical_merchant_core::utils::device::{self, Location, NetworkType};
use serde::Deserialize;

/// The runtime environment collected on the `WebView` side.
///
/// Android has neither an implementation in the `battery` crate nor
/// `SystemConfiguration`, so native code there sees nothing of power or network. This
/// is the input that fills in from whichever side can read it, and `None` means "that
/// side could not tell".
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

/// Prefers what native could read and fills only the gaps with the `WebView` values.
///
/// Native can ask the OS directly (the battery crate on macOS, for one), so it is the
/// more reliable of the two.
///
/// How the values are measured lives in core (`utils::device::probe`). It is not made
/// an app-only implementation, so that writes from the CLI and MCP leave the same
/// content.
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

/// A second attempt when the `WebView` has no coordinates. The Android geolocation
/// plugin answers on the front-end side, so this is only needed on macOS.
#[cfg(target_os = "macos")]
fn get_location() -> Option<Location> {
    crate::location::latest()
}

#[cfg(not(target_os = "macos"))]
const fn get_location() -> Option<Location> {
    None
}

/// The runtime environment the widget hands over as a single JSON string.
///
/// The path has no `WebView`, so the struct cannot be passed as it is and the JNI side
/// packs it into a string. If it cannot be read, fall back to the default, that is, to
/// "nothing was known". Making it fail here would only throw away the text that was
/// typed, and saving the capture itself holds even without the metadata.
///
/// Only the Android JNI bridge calls this, but it lives here and builds on every
/// platform. CI has no Android target, and the parsing is the part worth testing.
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

    /// Location alone may not have permission. An absent key means "not known", not a
    /// failure to save.
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

    /// Fills what the native side can say nothing about with the client-side values.
    /// Without this, Android leaves battery and network empty.
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
