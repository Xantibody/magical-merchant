//! The note file: a frontmatter record over the Markdown body.
//!
//! The `---` split itself is app-agnostic and lives in `utils::frontmatter`; what the
//! record holds, and what a note's first record looks like, is the note's rule.

use serde::{Deserialize, Serialize};

use crate::domain::note::Revision;
use crate::error::CoreError;
use crate::utils::clock::Stamp;
use crate::utils::device::{Context, Source};
use crate::utils::frontmatter;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteFrontmatter {
    pub time: Stamp,
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
    pub updated: Option<Stamp>,
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
    pub const fn new(time: Stamp) -> Self {
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

/// The whole text of a note at creation: its first record over `body`.
pub(crate) fn format_note_markdown(
    body: &str,
    tags: &[String],
    time: Stamp,
    context: &Context,
    provenance: Provenance<'_>,
) -> Result<String, CoreError> {
    let fm = NoteFrontmatter {
        tags: tags.to_vec(),
        context: Some(context.clone()),
        origin: provenance.origin.map(str::to_string),
        template: provenance.template.map(str::to_string),
        source: provenance.source.map(|s| s.as_str().to_string()),
        ..NoteFrontmatter::new(time)
    };
    frontmatter::render(&fm, body)
}

/// The whole text of a note after its body is rewritten to `body`. The frontmatter is a
/// record from creation, so it is left alone.
///
/// - time: creation time. The list is ordered by filename (creation time), so
///   moving it on edit makes the date group and the order disagree
/// - tags: already migrated to `#` notation in the body, but overwriting the
///   ones set from the tag field back then with an empty list strips old
///   notes of their classification
/// - context: a record of which device wrote it. Not overwritten with the editing device
///
/// A file whose frontmatter cannot be parsed is refused ([`CoreError::Parse`]).
/// Rebuilding it with the current time and device would drop `time` / `tags` /
/// `origin` / `view` / `template` / `source` on a one-character edit, and disagree
/// with the filename (= creation time). Refusing beats writing a fabricated
/// record: the same call as [`edit_record`]. Only a file with no delimiter
/// at all is written as before, since there is no record to lose. A file whose
/// opening delimiter is never closed is not "no record" but "broken": the lines
/// under `---` were written as a record, and overwriting them with the body loses them.
///
/// The only thing added here is `updated`, set to `now`. This path is the only one that
/// rewrites the body; replacing metadata or the view mode is not a "rewrite".
///
/// `expected` is the fingerprint of the body as read. If it differs from the
/// current body, someone wrote first; writing over it silently loses their edit, so
/// the rewrite is refused as [`CoreError::Stale`] under `name`.
pub(crate) fn rewrite(
    existing: &str,
    body: &str,
    context: &Context,
    expected: Option<&Revision>,
    now: Stamp,
    name: &str,
) -> Result<String, CoreError> {
    if let Some(expected) = expected {
        let current = Revision::of(frontmatter::strip(existing));
        if current != *expected {
            return Err(CoreError::Stale(name.to_string()));
        }
    }
    let fm = match frontmatter::parse::<NoteFrontmatter>(existing) {
        Ok((fm, _)) => NoteFrontmatter {
            updated: Some(now),
            ..fm
        },
        // A file with no record (plain Markdown dropped in from outside) may be
        // written. Only a file with no delimiter at all gets here: an unclosed
        // delimiter is a record that is broken, and rebuilding it loses the lines below
        Err(_) if frontmatter::is_plain_markdown(existing) => NoteFrontmatter {
            context: Some(context.clone()),
            ..NoteFrontmatter::new(now)
        },
        Err(e) => return Err(e),
    };
    frontmatter::render(&fm, body)
}

/// The whole text of a note after `edit` replaces part of its frontmatter. The body is
/// not touched.
///
/// Unlike [`rewrite`], a file whose frontmatter cannot be parsed is not rebuilt.
/// A body save must not be allowed to fail, but a metadata edit is better
/// refused than written as a fabricated record.
pub(crate) fn edit_record<F>(content: &str, edit: F) -> Result<String, CoreError>
where
    F: FnOnce(NoteFrontmatter) -> NoteFrontmatter,
{
    let (existing, body) = frontmatter::parse::<NoteFrontmatter>(content)?;
    frontmatter::render(&edit(existing), body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::frontmatter::{parse, render};

    fn sample_datetime() -> Stamp {
        Stamp::new(2026, 3, 20, 14, 30, 45, 9 * 3600).unwrap()
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

    /// A note that requires `time` cannot be read without a frontmatter.
    /// The list falls back to `strip` there and shows the body as the preview.
    #[test]
    fn a_note_without_frontmatter_is_a_parse_error() {
        let result = parse::<NoteFrontmatter>("just body");
        assert!(matches!(result, Err(CoreError::Parse(_))));
    }

    // ──────────── time bytes ────────────
    //
    // Frozen from chrono 0.4.45. A note's `time` / `updated` is part of its content hash,
    // so a rewrite that spells the same instant differently re-syncs the note.

    /// Reads a note whose `time:` is `value` and renders it back: the rewritten
    /// value, or the parse error as the IPC sees it.
    fn rewritten_time(value: &str) -> Result<String, String> {
        let doc = format!("---\ntime: {value}\ntags: []\n---\nbody");
        let (fm, _body): (NoteFrontmatter, &str) = parse(&doc).map_err(|e| e.to_string())?;
        let rendered = render(&fm, "body").unwrap();
        let line = rendered.lines().nth(1).unwrap();
        Ok(line.strip_prefix("time: ").unwrap().to_string())
    }

    /// A fraction is kept as 3, 6 or 9 digits, the fewest of those that hold it; it is
    /// never trimmed to the last non-zero digit.
    #[test]
    fn fractional_seconds_are_rewritten_byte_for_byte() {
        for (written, rewritten) in [
            (
                "2026-03-20T14:30:45.370362+09:00",
                "2026-03-20T14:30:45.370362+09:00",
            ),
            (
                "2026-03-20T14:30:45.544569369+09:00",
                "2026-03-20T14:30:45.544569369+09:00",
            ),
            (
                "2026-03-20T14:30:45.123400+09:00",
                "2026-03-20T14:30:45.123400+09:00",
            ),
            (
                "2026-03-20T14:30:45.120+09:00",
                "2026-03-20T14:30:45.120+09:00",
            ),
            (
                "2026-03-20T14:30:45.100000+09:00",
                "2026-03-20T14:30:45.100+09:00",
            ),
            ("2026-03-20T14:30:45+09:00", "2026-03-20T14:30:45+09:00"),
        ] {
            let doc = format!("---\ntime: {written}\ntags: []\nupdated: {written}\n---\nbody");
            let (fm, body): (NoteFrontmatter, &str) = parse(&doc).unwrap();
            assert_eq!(
                render(&fm, body).unwrap(),
                format!("---\ntime: {rewritten}\ntags: []\nupdated: {rewritten}\n---\nbody"),
                "written: {written}"
            );
        }
    }

    /// Every spelling of a zero offset is written back as `Z`, never `+00:00`.
    #[test]
    fn a_zero_offset_is_written_as_z() {
        for written in [
            "2026-03-20T05:30:45+00:00",
            "2026-03-20T05:30:45-00:00",
            "2026-03-20T05:30:45Z",
            "2026-03-20T05:30:45z",
        ] {
            assert_eq!(
                rewritten_time(written).as_deref(),
                Ok("2026-03-20T05:30:45Z"),
                "written: {written}"
            );
        }
    }

    /// A hand-edited `time:` is read by chrono's relaxed RFC 3339 parser. What it
    /// accepts must keep reading, or `update_note` starts refusing to save that note.
    #[test]
    fn hand_written_times_still_parse() {
        let rows: &[(&str, Result<&str, &str>)] = &[
            ("2026-03-20 14:30:45+09:00", Ok("2026-03-20T14:30:45+09:00")),
            ("2026-03-20t14:30:45+09:00", Ok("2026-03-20T14:30:45+09:00")),
            ("2026-03-20T14:30:45+0900", Ok("2026-03-20T14:30:45+09:00")),
            ("2026-03-20T05:30:45 UTC", Ok("2026-03-20T05:30:45Z")),
            ("2026-03-20T05:30:45 utc", Ok("2026-03-20T05:30:45Z")),
            ("2026-03-20T05:30:45UTC", Ok("2026-03-20T05:30:45Z")),
            ("2026-03-20T14:30:45+09 00", Ok("2026-03-20T14:30:45+09:00")),
            (
                "2026-03-20T09:30:45\u{2212}05:00",
                Ok("2026-03-20T09:30:45-05:00"),
            ),
            ("2026-3-2T4:3:5+09:00", Ok("2026-03-02T04:03:05+09:00")),
            (
                "2026-03-20T14:30:45.1234567891+09:00",
                Ok("2026-03-20T14:30:45.123456789+09:00"),
            ),
            (
                "2026-03-20T14:30:45.+09:00",
                Err("Parse error: time: input contains invalid characters at line 1 column 7"),
            ),
            (
                "2026-03-20T14:30:45+24:00",
                Err("Parse error: time: input is out of range at line 1 column 7"),
            ),
            ("2026-03-20T14:30:45+23:59", Ok("2026-03-20T14:30:45+23:59")),
            ("9999-12-31T23:00:00Z", Ok("9999-12-31T23:00:00Z")),
            ("+10000-01-01T00:00:00Z", Ok("+10000-01-01T00:00:00Z")),
            ("2026-03-20T14:30:60+09:00", Ok("2026-03-20T14:30:60+09:00")),
            (
                "2026-03-20T14:30+09:00",
                Err("Parse error: time: input contains invalid characters at line 1 column 7"),
            ),
        ];
        for &(written, expected) in rows {
            assert_eq!(
                rewritten_time(written).as_deref(),
                expected.map_err(str::to_string).as_deref(),
                "written: {written:?}"
            );
        }
    }

    /// Two records of the same instant are equal whatever offset each was written in.
    #[test]
    fn frontmatter_equality_ignores_the_offset() {
        let utc = Stamp::new(2026, 3, 20, 5, 30, 45, 0).unwrap();

        assert_eq!(NoteFrontmatter::new(utc), sample_fm());
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

    fn test_context() -> Context {
        Context {
            battery: Some(82),
            is_charging: Some(false),
            ..Context::default()
        }
    }

    #[test]
    fn test_format_note_markdown() {
        let tags = vec!["rust".to_string(), "memo".to_string()];
        let result = format_note_markdown(
            "# Hello\nWorld",
            &tags,
            sample_datetime(),
            &test_context(),
            Provenance::default(),
        )
        .unwrap();

        let (fm, body): (NoteFrontmatter, &str) = parse(&result).unwrap();
        assert_eq!(fm.tags, vec!["rust", "memo"]);
        assert!(fm.context.is_some());
        let ctx = fm.context.unwrap();
        assert_eq!(ctx.battery, Some(82));
        assert_eq!(ctx.is_charging, Some(false));
        assert_eq!(body, "# Hello\nWorld");
    }

    #[test]
    fn test_format_note_markdown_empty_tags() {
        let result = format_note_markdown(
            "body",
            &[],
            sample_datetime(),
            &test_context(),
            Provenance::default(),
        )
        .unwrap();
        let (fm, _body): (NoteFrontmatter, &str) = parse(&result).unwrap();
        assert!(fm.tags.is_empty());
    }

    #[test]
    fn test_format_note_markdown_charging() {
        let ctx = Context {
            battery: Some(100),
            is_charging: Some(true),
            ..Context::default()
        };
        let result =
            format_note_markdown("body", &[], sample_datetime(), &ctx, Provenance::default())
                .unwrap();
        let (fm, _body): (NoteFrontmatter, &str) = parse(&result).unwrap();
        let context = fm.context.unwrap();
        assert_eq!(context.battery, Some(100));
        assert_eq!(context.is_charging, Some(true));
    }

    // ──────────── rewrite and edit_record ────────────

    /// The clock reading a rewrite stamps: later than every record below.
    fn now() -> Stamp {
        Stamp::new(2026, 9, 1, 10, 0, 0, 9 * 3600).unwrap()
    }

    /// The device that saves, which is never the one that created the note.
    fn editing_device() -> Context {
        Context {
            battery: Some(7),
            is_charging: Some(true),
            ..Context::default()
        }
    }

    /// A note carrying every record key, already rewritten once.
    fn full_record() -> NoteFrontmatter {
        NoteFrontmatter {
            tags: vec!["sync".to_string()],
            context: Some(test_context()),
            view: Some("mindmap".to_string()),
            origin: Some("2026-03-20T08:30:00".to_string()),
            updated: Some(Stamp::new(2026, 4, 1, 9, 0, 0, 9 * 3600).unwrap()),
            template: Some("daily".to_string()),
            source: Some(Source::Cli.as_str().to_string()),
            ..sample_fm()
        }
    }

    fn rewrite_now(existing: &str, expected: Option<&Revision>) -> Result<String, CoreError> {
        rewrite(
            existing,
            "new body",
            &editing_device(),
            expected,
            now(),
            "20260320_143045.md",
        )
    }

    #[test]
    fn rewrite_refuses_a_body_that_moved_since_it_was_read() {
        let existing = render(&full_record(), "someone else's body").unwrap();
        let read = Revision::of("the body as it was read");

        let result = rewrite_now(&existing, Some(&read));

        assert!(matches!(result, Err(CoreError::Stale(ref name)) if name == "20260320_143045.md"));
    }

    #[test]
    fn rewrite_goes_through_with_the_revision_it_read() {
        let existing = render(&full_record(), "the body as it was read").unwrap();
        let read = Revision::of("the body as it was read");

        let written = rewrite_now(&existing, Some(&read)).unwrap();

        let (_, body): (NoteFrontmatter, &str) = parse(&written).unwrap();
        assert_eq!(body, "new body");
    }

    /// The revision is taken from the body alone, so a record that moved (a view switch,
    /// a tag edit) does not make the read stale.
    #[test]
    fn rewrite_compares_the_revision_with_the_body_alone() {
        let read = Revision::of("body");
        let moved_record = NoteFrontmatter {
            view: Some("preview".to_string()),
            ..full_record()
        };

        assert!(rewrite_now(&render(&moved_record, "body").unwrap(), Some(&read)).is_ok());
    }

    /// Plain Markdown dropped in from outside has no record to lose, so it gets its first
    /// one: the clock reading as its time and the saving device as its context.
    #[test]
    fn rewrite_gives_plain_markdown_its_first_frontmatter() {
        let written = rewrite_now("written elsewhere", None).unwrap();

        let (fm, body): (NoteFrontmatter, &str) = parse(&written).unwrap();
        assert_eq!(
            fm,
            NoteFrontmatter {
                context: Some(editing_device()),
                ..NoteFrontmatter::new(now())
            }
        );
        assert_eq!(body, "new body");
    }

    /// A record that cannot be read is refused rather than rebuilt: an unclosed delimiter
    /// and broken YAML both still hold lines written as a record.
    #[test]
    fn rewrite_refuses_a_record_it_cannot_read() {
        for existing in [
            "---\ntime: 2026-01-01T12:00:00+09:00\ntags:\n  - work\n",
            "---\ntime: [broken\ntags: [work]\n---\nbody",
        ] {
            assert!(
                matches!(rewrite_now(existing, None), Err(CoreError::Parse(_))),
                "{existing:?}"
            );
        }
    }

    /// Every record from creation is kept as it was; `updated` alone moves, to the clock
    /// reading, and the saving device does not replace the creating one.
    #[test]
    fn rewrite_keeps_the_record_and_moves_only_updated() {
        let existing = render(&full_record(), "old body").unwrap();

        let written = rewrite_now(&existing, None).unwrap();

        let (fm, body): (NoteFrontmatter, &str) = parse(&written).unwrap();
        assert_eq!(
            fm,
            NoteFrontmatter {
                updated: Some(now()),
                ..full_record()
            }
        );
        assert_eq!(body, "new body");
    }

    #[test]
    fn rewrite_gives_the_same_text_for_the_same_input() {
        let existing = render(&full_record(), "old body").unwrap();
        let read = Revision::of("old body");

        assert_eq!(
            rewrite_now(&existing, Some(&read)).unwrap(),
            rewrite_now(&existing, Some(&read)).unwrap()
        );
    }

    #[test]
    fn edit_record_refuses_a_record_it_cannot_read() {
        let result = edit_record("---\ntime: [broken\n---\nbody", |fm| fm);

        assert!(matches!(result, Err(CoreError::Parse(_))));
    }

    /// The body under the record comes back byte for byte, whitespace and line endings
    /// included.
    #[test]
    fn edit_record_leaves_the_body_byte_for_byte() {
        let body = "# Title\r\n\n  indented  \n\ttab\nlast line without newline";
        let content = render(&full_record(), body).unwrap();

        let edited = edit_record(&content, |fm| NoteFrontmatter { view: None, ..fm }).unwrap();

        assert!(edited.ends_with(&format!("---\n{body}")), "{edited:?}");
        let (fm, _): (NoteFrontmatter, &str) = parse(&edited).unwrap();
        assert_eq!(fm.view, None);
        assert_eq!(fm.origin, full_record().origin);
    }
}
