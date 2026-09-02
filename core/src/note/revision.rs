//! 「読んだときの本文」の指紋。書き戻すときに添えると、そのあいだに
//! 別の書き手(アプリ・MCP・CLI)が本文を変えていれば書き込みが断られる。
//!
//! アプリはファイルを監視しないので、外から書き換えられたノートを開いた
//! まま 1 文字打つと、autosave が古い本文ごと上書きする。書き手が誰であれ
//! 同じ穴なので、守りは書き込みの入口に 1 つだけ置く。
//!
//! 指紋は本文だけから取る。frontmatter は表示モードの切替やタグ編集でも
//! 動くが、それは本文を書き直したわけではなく、本文の書き込みは既存の
//! frontmatter を読み直して残す。frontmatter ごと指紋にすると、編集中に
//! 表示モードを切り替えただけで自分の保存が「古い」ことになる。

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
