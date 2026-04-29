use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Context {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub battery: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_charging: Option<bool>,
}

impl Context {
    pub fn mock() -> Self {
        Self {
            battery: Some(50),
            is_charging: Some(false),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_context_mock() {
        let ctx = Context::mock();
        assert_eq!(ctx.battery, Some(50));
        assert_eq!(ctx.is_charging, Some(false));
    }

    #[test]
    fn test_context_serialization_skips_none() {
        let ctx = Context {
            battery: None,
            is_charging: None,
        };
        let json = serde_json::to_string(&ctx).unwrap();
        assert_eq!(json, "{}");
    }

    #[test]
    fn test_context_serialization_with_values() {
        let ctx = Context {
            battery: Some(82),
            is_charging: Some(false),
        };
        let json = serde_json::to_string(&ctx).unwrap();
        assert!(json.contains("\"battery\":82"));
        assert!(json.contains("\"is_charging\":false"));
    }

    #[test]
    fn test_context_deserialization_old_format() {
        // Old format had bare values - serde handles Option transparently
        let json = r#"{"battery":82,"is_charging":false}"#;
        let ctx: Context = serde_json::from_str(json).unwrap();
        assert_eq!(ctx.battery, Some(82));
        assert_eq!(ctx.is_charging, Some(false));
    }

    #[test]
    fn test_context_deserialization_missing_fields() {
        let json = "{}";
        let ctx: Context = serde_json::from_str(json).unwrap();
        assert_eq!(ctx.battery, None);
        assert_eq!(ctx.is_charging, None);
    }
}
