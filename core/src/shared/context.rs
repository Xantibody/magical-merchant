use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct DeviceContext {
    pub battery: u8,
    pub is_charging: bool,
}

impl DeviceContext {
    pub fn mock() -> Self {
        Self {
            battery: 50,
            is_charging: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_device_context_mock() {
        let ctx = DeviceContext::mock();
        assert_eq!(ctx.battery, 50);
        assert!(!ctx.is_charging);
    }
}
