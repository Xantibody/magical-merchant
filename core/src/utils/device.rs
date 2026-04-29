use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

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
            os: Some("macos".to_string()),
            os_version: Some("15.3".to_string()),
            arch: Some("aarch64".to_string()),
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
