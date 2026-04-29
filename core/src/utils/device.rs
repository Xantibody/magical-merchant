use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Context {
    pub battery: u8,
    pub is_charging: bool,
}

impl Context {
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
    fn test_context_mock() {
        let ctx = Context::mock();
        assert_eq!(ctx.battery, 50);
        assert!(!ctx.is_charging);
    }
}
