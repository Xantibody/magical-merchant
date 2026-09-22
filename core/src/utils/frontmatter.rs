use chrono::{DateTime, FixedOffset};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::error::CoreError;
use crate::utils::device::{Context, Source};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteFrontmatter {
    pub time: DateTime<FixedOffset>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<Context>,
    /// Display mode (for example `mindmap`). Unlike time/tags/context it is not a
    /// record made at creation but a viewing preference; a per-note setting should
    /// sync with the note, so it lives in the frontmatter. Absent or unknown values
    /// fall back to the editor view on the reading side.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<String>,
    /// Datetime of the Scrawl entry this note was promoted from (`YYYY-MM-DDTHH:MM:SS`).
    /// Only notes made from an entry carry this provenance record; the chip on the
    /// Scrawl side is derived from this value every time (nothing is written to the
    /// entry's file).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    /// When the body was last rewritten. `time` is fixed at creation (the list is
    /// ordered by filename), so the fact of a rewrite survives only here.
    /// Not written for a note that was never edited: writing a default would change
    /// the frontmatter of every untouched note and trigger a full sync.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated: Option<DateTime<FixedOffset>>,
    /// Name of the template the note was born from (`daily` for `templates/daily.md`).
    /// A creation-time record like `origin`; resolving `{{prev}}` and deciding whether
    /// "today's note from the same template already exists" have no way other than
    /// scanning this value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    /// Which entry point wrote it (`app` / `cli` / `mcp` / `widget` / `import`).
    /// A creation-time record like `origin` / `template`; editing later with another
    /// tool does not change it. If "the tool that last edited" is needed, add another
    /// key: one key carrying both meanings can answer neither question.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

impl NoteFrontmatter {
    /// The record right after creation. Start with no optional keys and add only
    /// what is written, through `..NoteFrontmatter::new(time)`.
    ///
    /// Listing every field at each construction means that one new key rewrites
    /// every unrelated caller and test. New keys are added here only.
    #[must_use]
    pub const fn new(time: DateTime<FixedOffset>) -> Self {
        Self {
            time,
            tags: Vec::new(),
            context: None,
            view: None,
            origin: None,
            updated: None,
            template: None,
            source: None,
        }
    }
}

/// Provenance record written only at creation. Later edits do not rewrite it.
/// No note carries both so far: promoting an entry does not go through a template.
#[derive(Debug, Default, Clone, Copy)]
pub struct Provenance<'a> {
    /// Datetime of the Scrawl entry this note was promoted from (`YYYY-MM-DDTHH:MM:SS`).
    pub origin: Option<&'a str>,
    /// Name of the template the note was born from.
    pub template: Option<&'a str>,
    /// Which entry point wrote it. The caller names itself: if a shared helper
    /// decided, things that share a path, like the CLI and MCP, would get the same name.
    pub source: Option<Source>,
}

pub fn render<T: Serialize>(fm: &T, body: &str) -> Result<String, CoreError> {
    let yaml = serde_yaml::to_string(fm).map_err(|e| CoreError::Parse(e.to_string()))?;
    Ok(format!("---\n{yaml}---\n{body}"))
}

/// The body is returned as a borrow of `content`. Most callers use only the head,
/// so owning it here would copy the whole thing, including the part they discard.
///
/// Without a frontmatter it reads as an empty map: a type whose keys are all
/// optional passes with defaults, and a type with a required key such as `time`
/// fails here. Delimiters with nothing between them (`---\n---`) are treated the same.
///
/// The YAML is read straight into `T`. Building a `serde_yaml::Value` first and
/// converting it would create and discard one extra tree per note, and that was
/// the widest frame in the list (`list_notes`).
pub fn parse<T: DeserializeOwned>(content: &str) -> Result<(T, &str), CoreError> {
    let (matter, body) = match split(content) {
        Split::Some { matter, body } => (matter, body),
        Split::None { body } => ("", body),
        Split::Unclosed => {
            return Err(CoreError::Parse(
                "frontmatter is missing its closing delimiter".to_string(),
            ));
        }
    };
    let matter = if matter.trim().is_empty() {
        "{}"
    } else {
        matter
    };
    let fm = serde_yaml::from_str::<T>(matter).map_err(|e| CoreError::Parse(e.to_string()))?;
    Ok((fm, body))
}

/// Drops the frontmatter and returns only the body.
///
/// Unlike `parse` it does not look at the YAML, so a file with broken metadata does not leak it
/// into the body on screen. If the delimiter is not closed it is not treated as a frontmatter and
/// the whole text is returned.
#[must_use]
pub fn strip(content: &str) -> &str {
    match split(content) {
        Split::Some { body, .. } | Split::None { body } => body,
        Split::Unclosed => content.trim_start(),
    }
}

/// Whether there is no delimiter at all.
///
/// When `parse` fails, this tells "the record is broken" from "there is no record in the first
/// place": rebuilding the former erases the original record, while the latter has nothing to erase.
// AIDEV-NOTE: Asks for the side that may be rebuilt, not "is there a closed delimiter". In the negated form Unclosed fell on the permitted side
#[must_use]
pub fn is_plain_markdown(content: &str) -> bool {
    matches!(split(content), Split::None { .. })
}

enum Split<'a> {
    /// The inside of the delimiters, and the body from the line after the closing one.
    Some { matter: &'a str, body: &'a str },
    /// Does not start with `---`. The body is the whole text with leading whitespace dropped.
    None { body: &'a str },
    /// There is an opening delimiter but no closing one.
    Unclosed,
}

/// The delimiter rules live in this one place: leading whitespace is dropped, a line
/// may end in LF / CRLF / CR, and a `---` right after the opening one also closes.
/// `parse` and `strip` share this split, so the list and the editing path never
/// disagree on where the body starts.
fn split(content: &str) -> Split<'_> {
    let content = content.trim_start();
    let Some(first) = next_line(content, 0) else {
        return Split::None { body: content };
    };
    if first.text != "---" {
        return Split::None { body: content };
    }
    let mut pos = first.next_start;
    while let Some(line) = next_line(content, pos) {
        if line.text == "---" {
            return Split::Some {
                matter: &content[first.next_start..line.start],
                body: &content[line.next_start..],
            };
        }
        pos = line.next_start;
    }
    Split::Unclosed
}

struct Line<'a> {
    /// The line's content without its line ending.
    text: &'a str,
    /// Where this line starts.
    start: usize,
    /// Where the next line starts. The string length if there is no line ending (last line).
    next_start: usize,
}

/// Cuts one line out from `pos`. The line may end in LF / CRLF / CR.
fn next_line(s: &str, pos: usize) -> Option<Line<'_>> {
    let bytes = s.as_bytes();
    if pos >= bytes.len() {
        return None;
    }
    let mut end = pos;
    while end < bytes.len() && bytes[end] != b'\n' && bytes[end] != b'\r' {
        end += 1;
    }
    let mut next_start = end;
    if next_start < bytes.len() && bytes[next_start] == b'\r' {
        next_start += 1;
    }
    if next_start < bytes.len() && bytes[next_start] == b'\n' {
        next_start += 1;
    }
    Some(Line {
        text: &s[pos..end],
        start: pos,
        next_start,
    })
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

    fn sample_fm() -> NoteFrontmatter {
        NoteFrontmatter::new(sample_datetime())
    }

    #[test]
    fn test_note_frontmatter_roundtrip() {
        let fm = NoteFrontmatter {
            tags: vec!["memo".to_string()],
            context: Some(Context {
                battery: Some(82),
                is_charging: Some(false),
                ..Context::default()
            }),
            ..sample_fm()
        };
        let rendered = render(&fm, "# Hello\nWorld").unwrap();
        let (parsed, body): (NoteFrontmatter, _) = parse(&rendered).unwrap();
        assert_eq!(parsed, fm);
        assert_eq!(body, "# Hello\nWorld");
    }

    #[test]
    fn test_note_frontmatter_view_roundtrip() {
        let fm = NoteFrontmatter {
            view: Some("mindmap".to_string()),
            ..sample_fm()
        };
        let rendered = render(&fm, "body").unwrap();
        let (parsed, _body): (NoteFrontmatter, _) = parse(&rendered).unwrap();
        assert_eq!(parsed.view, Some("mindmap".to_string()));
    }

    /// The frontmatter of a note without a view does not change by a single byte.
    /// Writing an extra key changes the content hash, and sync re-transfers every note.
    #[test]
    fn test_render_omits_absent_view() {
        let rendered = render(&sample_fm(), "body").unwrap();
        assert!(!rendered.contains("view"));
    }

    /// A note written by an app version that does not know the view key still reads as before.
    #[test]
    fn test_parse_defaults_view_to_none() {
        let yaml = "---\ntime: 2026-03-20T14:30:45+09:00\ntags: []\n---\nbody";
        let (fm, _body): (NoteFrontmatter, &str) = parse(yaml).unwrap();
        assert_eq!(fm.view, None);
    }

    #[test]
    fn test_note_frontmatter_updated_roundtrip() {
        let fm = NoteFrontmatter {
            updated: Some(sample_datetime()),
            ..sample_fm()
        };
        let rendered = render(&fm, "body").unwrap();
        let (parsed, _body): (NoteFrontmatter, _) = parse(&rendered).unwrap();
        assert_eq!(parsed.updated, Some(sample_datetime()));
    }

    /// A note that was never edited has no updated time. Writing even an empty value
    /// rewrites the frontmatter of every note and triggers a full sync.
    #[test]
    fn test_render_omits_absent_updated() {
        let rendered = render(&sample_fm(), "body").unwrap();
        assert!(!rendered.contains("updated"));
    }

    /// A note written by an app version that does not know the updated key still reads as before.
    #[test]
    fn test_parse_defaults_updated_to_none() {
        let yaml = "---\ntime: 2026-03-20T14:30:45+09:00\ntags: []\n---\nbody";
        let (fm, _body): (NoteFrontmatter, &str) = parse(yaml).unwrap();
        assert_eq!(fm.updated, None);
    }

    #[test]
    fn test_note_frontmatter_origin_roundtrip() {
        let fm = NoteFrontmatter {
            origin: Some("2026-08-13T08:30:00".to_string()),
            ..sample_fm()
        };
        let rendered = render(&fm, "body").unwrap();
        let (parsed, _body): (NoteFrontmatter, _) = parse(&rendered).unwrap();
        assert_eq!(parsed.origin, Some("2026-08-13T08:30:00".to_string()));
    }

    /// The frontmatter of a note without an origin does not change by a single byte.
    /// The same promise as view: a key that was not written is not written.
    #[test]
    fn test_render_omits_absent_origin() {
        let rendered = render(&sample_fm(), "body").unwrap();
        assert!(!rendered.contains("origin"));
    }

    /// A note written by an app version that does not know the origin key still reads as before.
    #[test]
    fn test_parse_defaults_origin_to_none() {
        let yaml = "---\ntime: 2026-03-20T14:30:45+09:00\ntags: []\n---\nbody";
        let (fm, _body): (NoteFrontmatter, &str) = parse(yaml).unwrap();
        assert_eq!(fm.origin, None);
    }

    #[test]
    fn test_note_frontmatter_source_roundtrip() {
        let fm = NoteFrontmatter {
            source: Some(Source::Cli.as_str().to_string()),
            ..sample_fm()
        };
        let rendered = render(&fm, "body").unwrap();
        let (parsed, _body): (NoteFrontmatter, _) = parse(&rendered).unwrap();
        assert_eq!(parsed.source, Some("cli".to_string()));
    }

    /// The frontmatter of a note that names no source does not change by a single byte.
    /// The same promise as view / origin: a key that was not written is not written. A
    /// key added to an existing note moves the content hash, and every device syncs it
    /// as "changed".
    #[test]
    fn test_render_omits_absent_source() {
        let rendered = render(&sample_fm(), "body").unwrap();
        assert!(!rendered.contains("source"));
    }

    /// A note written by an app version that does not know the source key still reads as before.
    #[test]
    fn test_parse_defaults_source_to_none() {
        let yaml = "---\ntime: 2026-03-20T14:30:45+09:00\ntags: []\n---\nbody";
        let (fm, _body): (NoteFrontmatter, &str) = parse(yaml).unwrap();
        assert_eq!(fm.source, None);
    }

    #[test]
    fn test_note_frontmatter_no_context() {
        let fm = sample_fm();
        let rendered = render(&fm, "body").unwrap();
        let (parsed, _body): (NoteFrontmatter, _) = parse(&rendered).unwrap();
        assert_eq!(parsed, fm);
    }

    #[test]
    fn test_render_contains_delimiters() {
        let rendered = render(&sample_fm(), "body").unwrap();
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

    /// Even when the YAML is broken, what is between the delimiters does not leak into the body.
    #[test]
    fn strip_drops_broken_yaml_frontmatter() {
        assert_eq!(strip("---\n:{ not yaml ::\n---\nbody"), "body");
    }

    #[test]
    fn strip_handles_empty_body() {
        assert_eq!(strip("---\ntime: x\n---"), "");
    }

    /// Without a closing delimiter it is not a frontmatter (it may be a horizontal rule
    /// at the top of the body).
    #[test]
    fn strip_keeps_unclosed_delimiter() {
        assert_eq!(strip("---\nno closing"), "---\nno closing");
    }

    /// A note written with CRLF. `parse` accepts it, so the list comes out fine, but
    /// if `strip` cannot peel it, the frontmatter flows into the body on the editing
    /// path only, gets saved as is, and sticks.
    #[test]
    fn strip_removes_crlf_frontmatter() {
        assert_eq!(strip("---\r\ntime: x\r\n---\r\nbody line"), "body line");
    }

    /// In an empty frontmatter the `---` right after the opening one is the closing delimiter.
    #[test]
    fn strip_removes_empty_frontmatter() {
        assert_eq!(strip("---\n---\nbody line"), "body line");
    }

    /// `parse` and `strip` return the same body from the same note. The original bug
    /// was that line endings and empty frontmatters were handled on only one side: the
    /// list (`parse`) was right while the editing path (`strip`) alone held the
    /// frontmatter as body.
    #[test]
    fn strip_matches_parse_body() {
        for content in [
            // LF
            "---\ntime: x\n---\nbody line\n",
            // CRLF
            "---\r\ntime: x\r\n---\r\nbody line\r\n",
            // CR only
            "---\rtime: x\r---\rbody line\r",
            // empty frontmatter
            "---\n---\nbody line\n",
            // a line equal to the closing delimiter inside the body
            "---\ntime: x\n---\nbefore\n---\nafter\n",
            // leading whitespace
            "\n\n  ---\ntime: x\n---\nbody line\n",
            // no frontmatter
            "body line\n",
        ] {
            let (_fm, body): (serde_yaml::Value, &str) = parse(content).unwrap();
            assert_eq!(strip(content), body, "content: {content:?}");
        }
    }

    // ──────────── boundaries ────────────

    /// A type whose keys are all optional reads as defaults whether the frontmatter is
    /// absent or empty. The device list of a day file is one. Treating a bare `---\n---`
    /// as broken metadata leaves the `---` lines in the body (as entries).
    #[test]
    fn an_absent_or_empty_frontmatter_reads_as_defaults() {
        #[derive(Debug, Default, PartialEq, serde::Deserialize)]
        struct Optional {
            #[serde(default)]
            items: Vec<String>,
        }

        for content in ["body", "---\n---\nbody", "---\n\n---\nbody"] {
            let (fm, body): (Optional, &str) = parse(content).unwrap();
            assert_eq!(fm, Optional::default(), "content: {content:?}");
            assert_eq!(body, "body", "content: {content:?}");
        }
    }

    /// A note that requires `time` cannot be read without a frontmatter.
    /// The list falls back to `strip` there and shows the body as the preview.
    #[test]
    fn a_note_without_frontmatter_is_a_parse_error() {
        let result = parse::<NoteFrontmatter>("just body");
        assert!(matches!(result, Err(CoreError::Parse(_))));
    }

    /// A body with only an opening delimiter. `parse` fails and `strip` returns the
    /// whole text: treating an unclosed one as a frontmatter erases the entire body.
    #[test]
    fn an_unclosed_delimiter_is_not_a_frontmatter() {
        let content = "---\ntime: x\nbody line";
        assert!(matches!(
            parse::<serde_yaml::Value>(content),
            Err(CoreError::Parse(_))
        ));
        assert_eq!(strip(content), content);
    }

    /// A file that ends right after the closing delimiter. The body is empty and nothing
    /// is read out of range.
    #[test]
    fn a_closing_delimiter_at_the_very_end_leaves_an_empty_body() {
        let (_fm, body): (serde_yaml::Value, &str) = parse("---\ntime: x\n---").unwrap();
        assert_eq!(body, "");
    }

    /// A line with whitespace around `---` or extra symbols on it is not a delimiter.
    #[test]
    fn a_delimiter_must_be_exactly_three_dashes() {
        for content in ["--- \ntime: x\n---\nbody", "----\ntime: x\n---\nbody"] {
            assert_eq!(strip(content), content, "content: {content:?}");
        }
        assert_eq!(strip("---\ntime: x\n--- \n---\nbody"), "body");
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
