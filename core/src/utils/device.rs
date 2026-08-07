use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum NetworkType {
    WiFi,
    Mobile,
    Offline,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Location {
    pub latitude: f64,
    pub longitude: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Context {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub battery: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_charging: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network_type: Option<NetworkType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wifi_ssid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<Location>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub os: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os_version: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub arch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
}

/// 同じ端末で書いている限り 1 日を通して変わらない部分。
///
/// 日ファイルの先頭にまとめて置き、各エントリの行末からは省く。エントリ 1 件
/// あたり 100 文字を超えるこれらを全行で繰り返すと、本文が数文字のエントリでは
/// メタデータのほうが桁で長くなり、Markdown として読めたものではなくなる。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeviceIdentity {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub os: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os_version: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub arch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
}

impl Context {
    /// 日ファイルの先頭に移す部分。
    #[must_use]
    pub fn identity(&self) -> DeviceIdentity {
        DeviceIdentity {
            os: self.os.clone(),
            os_version: self.os_version.clone(),
            arch: self.arch.clone(),
            hostname: self.hostname.clone(),
            locale: self.locale.clone(),
        }
    }

    /// 記録のたびに変わりうる部分だけを残したもの。行末に書くのはこちら。
    #[must_use]
    pub fn volatile(&self) -> Self {
        Self {
            battery: self.battery,
            is_charging: self.is_charging,
            network_type: self.network_type.clone(),
            wifi_ssid: self.wifi_ssid.clone(),
            location: self.location.clone(),
            ..Self::default()
        }
    }

    /// 分けて保存したものを 1 つに戻す。読み出し側から見た形は分割前と変わらない。
    #[must_use]
    pub fn with_identity(mut self, identity: &DeviceIdentity) -> Self {
        self.os.clone_from(&identity.os);
        self.os_version.clone_from(&identity.os_version);
        self.arch.clone_from(&identity.arch);
        self.hostname.clone_from(&identity.hostname);
        self.locale.clone_from(&identity.locale);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full_context() -> Context {
        Context {
            battery: Some(82),
            is_charging: Some(false),
            network_type: Some(NetworkType::WiFi),
            wifi_ssid: Some("MyNetwork".to_string()),
            location: Some(Location {
                latitude: 35.6762,
                longitude: 139.6503,
            }),
            os: "macos".to_string(),
            os_version: Some("15.3".to_string()),
            arch: "aarch64".to_string(),
            hostname: Some("MacBook".to_string()),
            locale: Some("ja_JP".to_string()),
        }
    }

    #[test]
    fn identity_keeps_only_what_lasts_the_day() {
        let identity = full_context().identity();

        assert_eq!(identity.os, "macos");
        assert_eq!(identity.os_version.as_deref(), Some("15.3"));
        assert_eq!(identity.arch, "aarch64");
        assert_eq!(identity.hostname.as_deref(), Some("MacBook"));
        assert_eq!(identity.locale.as_deref(), Some("ja_JP"));
    }

    #[test]
    fn volatile_keeps_only_what_changes_per_entry() {
        let volatile = full_context().volatile();

        assert_eq!(volatile.battery, Some(82));
        assert_eq!(volatile.network_type, Some(NetworkType::WiFi));
        assert!(volatile.location.is_some());
        assert_eq!(volatile.os, "");
        assert_eq!(volatile.os_version, None);
        assert_eq!(volatile.hostname, None);
    }

    #[test]
    fn splitting_and_rejoining_round_trips() {
        let context = full_context();

        let rejoined = context.volatile().with_identity(&context.identity());

        assert_eq!(rejoined, context);
    }

    #[test]
    fn a_volatile_context_serializes_without_the_identity_keys() {
        let json = serde_json::to_string(&full_context().volatile()).unwrap();

        assert!(json.contains("\"battery\":82"));
        assert!(!json.contains("\"os\""));
        assert!(!json.contains("\"hostname\""));
    }

    #[test]
    fn test_context_default() {
        let ctx = Context::default();
        assert_eq!(ctx.battery, None);
        assert_eq!(ctx.is_charging, None);
        assert_eq!(ctx.network_type, None);
        assert_eq!(ctx.wifi_ssid, None);
        assert_eq!(ctx.location, None);
    }

    #[test]
    fn test_context_serialization_skips_none() {
        let ctx = Context::default();
        let json = serde_json::to_string(&ctx).unwrap();
        assert_eq!(json, "{}");
    }

    #[test]
    fn test_context_serialization_with_all_fields() {
        let ctx = Context {
            battery: Some(82),
            is_charging: Some(false),
            network_type: Some(NetworkType::WiFi),
            wifi_ssid: Some("MyNetwork".to_string()),
            location: Some(Location {
                latitude: 35.6762,
                longitude: 139.6503,
            }),
            os: "macos".to_string(),
            os_version: Some("15.3".to_string()),
            arch: "aarch64".to_string(),
            hostname: Some("MacBook".to_string()),
            locale: Some("ja_JP".to_string()),
        };
        let json = serde_json::to_string(&ctx).unwrap();
        assert!(json.contains("\"battery\":82"));
        assert!(json.contains("\"network_type\":\"WiFi\""));
        assert!(json.contains("\"wifi_ssid\":\"MyNetwork\""));
        assert!(json.contains("\"latitude\":35.6762"));
        assert!(json.contains("\"os\":\"macos\""));
        assert!(json.contains("\"hostname\":\"MacBook\""));
    }

    #[test]
    fn test_context_deserialization_old_format() {
        let json = r#"{"battery":82,"is_charging":false}"#;
        let ctx: Context = serde_json::from_str(json).unwrap();
        assert_eq!(ctx.battery, Some(82));
        assert_eq!(ctx.is_charging, Some(false));
        assert_eq!(ctx.network_type, None);
        assert_eq!(ctx.wifi_ssid, None);
        assert_eq!(ctx.location, None);
    }

    #[test]
    fn test_context_deserialization_missing_fields() {
        let json = "{}";
        let ctx: Context = serde_json::from_str(json).unwrap();
        assert_eq!(ctx.battery, None);
        assert_eq!(ctx.network_type, None);
    }

    #[test]
    fn test_network_type_serialization() {
        let ctx = Context {
            network_type: Some(NetworkType::Mobile),
            ..Context::default()
        };
        let json = serde_json::to_string(&ctx).unwrap();
        assert_eq!(json, r#"{"network_type":"Mobile"}"#);
    }
}
