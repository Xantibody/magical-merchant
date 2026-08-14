use chrono::{DateTime, FixedOffset};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::error::CoreError;
use crate::utils::device::Context;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteFrontmatter {
    pub time: DateTime<FixedOffset>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<Context>,
    /// 表示モード(例: `mindmap`)。time/tags/context と違い「作成時の記録」では
    /// なく閲覧の好みだが、ノート単位の設定はノートと一緒に同期されてほしいので
    /// frontmatter に持つ。未指定・未知の値は読む側がエディタ表示に倒す。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<String>,
}

pub fn render<T: Serialize>(fm: &T, body: &str) -> Result<String, CoreError> {
    let yaml = serde_yaml::to_string(fm).map_err(|e| CoreError::Parse(e.to_string()))?;
    Ok(format!("---\n{yaml}---\n{body}"))
}

/// 本文は `content` を借りて返す。呼び出し側の多くは先頭だけしか使わないので、
/// ここで所有権を持たせると読み捨てるぶんまで丸ごと複製することになる。
pub fn parse<T: DeserializeOwned>(content: &str) -> Result<(T, &str), CoreError> {
    markdown_frontmatter::parse::<T>(content).map_err(|e| CoreError::Parse(format!("{e:?}")))
}

/// frontmatter を捨てて本文だけを返す。`parse` と違い YAML の中身は見ないので、
/// メタデータが壊れているファイルでも本文が画面に漏れ出さない。
/// 区切りが閉じていなければ frontmatter とはみなさず全文を返す。
#[must_use]
pub fn strip(content: &str) -> &str {
    let Some(rest) = content.strip_prefix("---\n") else {
        return content;
    };
    if let Some(idx) = rest.find("\n---\n") {
        return &rest[idx + "\n---\n".len()..];
    }
    if rest.ends_with("\n---") {
        // 閉じ区切りがファイル末尾: 本文が空のノート
        return "";
    }
    content
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn fixed_offset() -> FixedOffset {
        FixedOffset::east_opt(9 * 3600).unwrap()
    }

    fn sample_datetime() -> DateTime<FixedOffset> {
        fixed_offset()
            .with_ymd_and_hms(2026, 3, 20, 14, 30, 45)
            .unwrap()
    }

    #[test]
    fn test_note_frontmatter_roundtrip() {
        let fm = NoteFrontmatter {
            time: sample_datetime(),
            tags: vec!["memo".to_string()],
            context: Some(Context {
                battery: Some(82),
                is_charging: Some(false),
                ..Context::default()
            }),
            view: None,
        };
        let rendered = render(&fm, "# Hello\nWorld").unwrap();
        let (parsed, body): (NoteFrontmatter, _) = parse(&rendered).unwrap();
        assert_eq!(parsed, fm);
        assert_eq!(body, "# Hello\nWorld");
    }

    #[test]
    fn test_note_frontmatter_view_roundtrip() {
        let fm = NoteFrontmatter {
            time: sample_datetime(),
            tags: vec![],
            context: None,
            view: Some("mindmap".to_string()),
        };
        let rendered = render(&fm, "body").unwrap();
        let (parsed, _body): (NoteFrontmatter, _) = parse(&rendered).unwrap();
        assert_eq!(parsed.view, Some("mindmap".to_string()));
    }

    /// view を持たないノートの frontmatter は今までと 1 バイトも変わらない。
    /// 余計なキーを書くと、同期(Syncthing)が全ノートを転送し直すことになる。
    #[test]
    fn test_render_omits_absent_view() {
        let fm = NoteFrontmatter {
            time: sample_datetime(),
            tags: vec![],
            context: None,
            view: None,
        };
        let rendered = render(&fm, "body").unwrap();
        assert!(!rendered.contains("view"));
    }

    /// view キーを知らない版のアプリが書いたノートも今まで通り読める。
    #[test]
    fn test_parse_defaults_view_to_none() {
        let yaml = "---\ntime: 2026-03-20T14:30:45+09:00\ntags: []\n---\nbody";
        let (fm, _body): (NoteFrontmatter, &str) = parse(yaml).unwrap();
        assert_eq!(fm.view, None);
    }

    #[test]
    fn test_note_frontmatter_no_context() {
        let fm = NoteFrontmatter {
            time: sample_datetime(),
            tags: vec![],
            context: None,
            view: None,
        };
        let rendered = render(&fm, "body").unwrap();
        let (parsed, _body): (NoteFrontmatter, _) = parse(&rendered).unwrap();
        assert_eq!(parsed, fm);
    }

    #[test]
    fn test_render_contains_delimiters() {
        let fm = NoteFrontmatter {
            time: sample_datetime(),
            tags: vec![],
            context: None,
            view: None,
        };
        let rendered = render(&fm, "body").unwrap();
        assert!(rendered.starts_with("---\n"));
        assert!(rendered.contains("\n---\n"));
        assert!(rendered.ends_with("body"));
    }

    #[test]
    fn strip_removes_frontmatter() {
        assert_eq!(strip("---\ntime: x\n---\nbody line"), "body line");
    }

    #[test]
    fn strip_returns_whole_content_without_frontmatter() {
        assert_eq!(strip("just body"), "just body");
    }

    /// YAML として壊れていても、区切りの中身を本文に漏らさない。
    #[test]
    fn strip_drops_broken_yaml_frontmatter() {
        assert_eq!(strip("---\n:{ not yaml ::\n---\nbody"), "body");
    }

    #[test]
    fn strip_handles_empty_body() {
        assert_eq!(strip("---\ntime: x\n---"), "");
    }

    /// 閉じ区切りが無いなら frontmatter ではない(本文先頭の水平線かもしれない)。
    #[test]
    fn strip_keeps_unclosed_delimiter() {
        assert_eq!(strip("---\nno closing"), "---\nno closing");
    }

    #[test]
    fn test_note_frontmatter_old_format_compat() {
        // Old format only had battery and is_charging
        let yaml = "---\ntime: 2026-03-20T14:30:45+09:00\ntags: []\ncontext:\n  battery: 82\n  is_charging: false\n---\nbody";
        let (fm, body): (NoteFrontmatter, &str) = parse(yaml).unwrap();
        let ctx = fm.context.unwrap();
        assert_eq!(ctx.battery, Some(82));
        assert_eq!(ctx.is_charging, Some(false));
        assert_eq!(ctx.network_type, None);
        assert_eq!(body, "body");
    }
}
