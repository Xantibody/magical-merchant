//! The revision: a fingerprint of "the body as it was read". Attached to a write-back, it
//! makes the write refused if another writer (app, MCP, CLI) changed the body in between.
//!
//! The app does not watch files, so typing one character into a note that was rewritten
//! from outside makes autosave overwrite the old body with it. Whoever the writer is, the
//! hole is the same, so the guard sits in one place: the entry of the write.
//!
//! The revision is taken from the body only. Frontmatter also moves on a view-mode switch
//! or a tag edit, but that is not a rewrite of the body, and a body write rereads the
//! existing frontmatter and keeps it. If the revision covered the frontmatter too, switching
//! the view mode while editing would make one's own save "stale".

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Revision(String);

impl Revision {
    #[must_use]
    pub fn of(body: &str) -> Self {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let digest = Sha256::digest(body.as_bytes());
        let mut hex = String::with_capacity(digest.len() * 2);
        for byte in digest {
            hex.push(char::from(HEX[usize::from(byte >> 4)]));
            hex.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
        Self(hex)
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for Revision {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<String> for Revision {
    fn from(value: String) -> Self {
        Self(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_body_has_the_same_revision() {
        assert_eq!(Revision::of("a\nb"), Revision::of("a\nb"));
        assert_ne!(Revision::of("a\nb"), Revision::of("a\nc"));
    }

    #[test]
    fn a_revision_is_lowercase_hex_and_survives_a_round_trip_as_a_string() {
        let rev = Revision::of("body");
        assert_eq!(rev.as_str().len(), 64);
        assert!(rev.as_str().bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(Revision::from(rev.to_string()), rev);
    }
}
