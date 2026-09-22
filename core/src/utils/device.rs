use serde::{Deserialize, Serialize};

/// The part that measures the device and fills a [`Context`]. It asks the OS for
/// `hostname` and battery level, so a user who only reads and writes notes does not need it.
#[cfg(feature = "device-probe")]
mod probe;
#[cfg(feature = "device-probe")]
pub use probe::{location, probe};

/// How the device was connected to the outside.
///
/// The network name (SSID) is not held. From macOS 14 on it is hidden without the
/// location permission, and the location answers "where was this written" more precisely anyway.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum NetworkType {
    WiFi,
    Ethernet,
    Mobile,
    Offline,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Location {
    pub latitude: f64,
    pub longitude: f64,
}

/// Which entry point wrote it. A record fixed only at creation; editing later with
/// another tool does not change it (the same as `context` / `origin` / `template`).
///
/// It does not go into `Context`. That is "what state the device was in", split
/// into `identity`, which does not change through the day, and `volatile`, which
/// changes per record. The tool that wrote it is neither, and mixing it in would
/// also let it slip into a note's `context:` block.
///
/// The vocabulary is fixed. Only the lowercase strings of [`Self::as_str`] go
/// outside, and a reader can pass an unknown value through untouched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// The Tauri app itself.
    App,
    /// The `magical-merchant` CLI.
    Cli,
    /// An agent through the MCP server.
    Mcp,
    /// The Android home-screen widget.
    Widget,
    /// Records moved in from outside. They were written outside this app, and the
    /// creation time is passed by the moving side too ([`crate::create_note_at`]).
    /// Mixed into `cli`, there would be no way to select just the moved ones again.
    Import,
}

impl Source {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::App => "app",
            Self::Cli => "cli",
            Self::Mcp => "mcp",
            Self::Widget => "widget",
            Self::Import => "import",
        }
    }
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

/// The part that does not change through the day as long as the same device is writing.
///
/// Placed together at the head of the day file and left off the end of each entry.
/// Repeating these, over 100 characters per entry, on every line would make the
/// metadata an order of magnitude longer than a body of a few characters, and the
/// file would no longer be readable as Markdown.
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
    /// The part moved to the head of the day file.
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

    /// Only the part that may change per record. This is what goes at the end of the line.
    #[must_use]
    pub fn volatile(&self) -> Self {
        Self {
            battery: self.battery,
            is_charging: self.is_charging,
            network_type: self.network_type.clone(),
            location: self.location.clone(),
            ..Self::default()
        }
    }

    /// Puts what was stored apart back into one. To the reading side the shape is the
    /// same as before the split.
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
        assert_eq!(ctx.location, None);
    }

    #[test]
    fn test_context_deserialization_missing_fields() {
        let json = "{}";
        let ctx: Context = serde_json::from_str(json).unwrap();
        assert_eq!(ctx.battery, None);
        assert_eq!(ctx.network_type, None);
    }

    /// What goes outside is the fixed lowercase vocabulary. This string lands on the
    /// display and in the file, so a leaked `Debug` spelling (`App`) would scatter the
    /// records across versions.
    #[test]
    fn a_source_names_itself_in_lowercase() {
        assert_eq!(Source::App.as_str(), "app");
        assert_eq!(Source::Cli.as_str(), "cli");
        assert_eq!(Source::Mcp.as_str(), "mcp");
        assert_eq!(Source::Widget.as_str(), "widget");
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
