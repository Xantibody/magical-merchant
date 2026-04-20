use std::fmt;

use crate::error::CoreError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Slug(String);

impl Slug {
    pub fn parse(s: &str) -> Result<Self, CoreError> {
        if s.is_empty()
            || !s
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            || s.starts_with('-')
            || s.ends_with('-')
        {
            return Err(CoreError::InvalidSlug(s.to_string()));
        }
        Ok(Self(s.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Slug {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_slug_parse_valid() {
        assert!(Slug::parse("my-project").is_ok());
        assert!(Slug::parse("project123").is_ok());
        assert!(Slug::parse("a").is_ok());
        assert!(Slug::parse("abc-def-123").is_ok());
    }

    #[test]
    fn test_slug_parse_invalid() {
        assert!(Slug::parse("").is_err());
        assert!(Slug::parse("My-Project").is_err());
        assert!(Slug::parse("-start").is_err());
        assert!(Slug::parse("end-").is_err());
        assert!(Slug::parse("has space").is_err());
        assert!(Slug::parse("under_score").is_err());
    }

    #[test]
    fn test_slug_parse_returns_invalid_slug_error() {
        let err = Slug::parse("Bad Slug").unwrap_err();
        assert!(matches!(err, CoreError::InvalidSlug(_)));
    }

    #[test]
    fn test_slug_as_str_roundtrip() {
        let slug = Slug::parse("foo").unwrap();
        assert_eq!(slug.as_str(), "foo");
    }

    #[test]
    fn test_slug_display() {
        let slug = Slug::parse("my-project").unwrap();
        assert_eq!(format!("{slug}"), "my-project");
    }
}
