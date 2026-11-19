//! Adding one line to today's Scrawl.

use std::path::Path;

use super::day::{DayLog, scrawl_file_path};
use super::journal::read_raw;
use super::migrate::migrate_scrawl_dir;
use crate::error::CoreError;
use crate::services::files::{ensure_dir, write_atomic};
use crate::utils::clock::WallClock;
use crate::utils::device::{Context, Source};

/// Adds one line to today's file.
///
/// `source` is the entry point the writer names itself as; the app, the CLI and the widget all go
/// through the same core function (the MCP server only reads Scrawl), so unless it is named here
/// the records cannot tell them apart.
pub fn save_scrawl_entry(
    base_dir: &Path,
    text: &str,
    context: &Context,
    source: Source,
) -> Result<(), CoreError> {
    // Every capture path ends here, so no entry point has to remember this. A failed move
    // is no reason to lose the entry: the next write tries again
    let _ = migrate_scrawl_dir(base_dir);
    let now = WallClock::now_local();
    let file_path = scrawl_file_path(base_dir, now.date());
    ensure_dir(&file_path)?;

    let mut day = DayLog::parse(&read_raw(base_dir, now.date())?.unwrap_or_default());
    day.push(text, now, context, Some(source));

    write_atomic(&file_path, day.render()?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::scrawl::journal::read_scrawl;
    use crate::utils::clock::Day;
    use std::fs;
    use tempfile::TempDir;

    fn mock_context() -> Context {
        Context {
            battery: Some(50),
            is_charging: Some(false),
            ..Context::default()
        }
    }

    #[test]
    fn test_save_scrawl_entry_creates_file() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(tmp.path(), "hello", &mock_context(), Source::App).unwrap();

        let today = Day::today_local().ymd();
        let file = tmp.path().join("data/scrawl").join(format!("{today}.md"));
        assert!(file.exists());

        let content = fs::read_to_string(&file).unwrap();
        assert!(content.contains("hello"));
        assert!(content.contains("battery"));
    }

    /// The app, the CLI and the widget all go through this one function (MCP only reads).
    /// The `s` at the end of the line is the only later clue to which entry point wrote it.
    #[test]
    fn a_saved_entry_names_the_tool_that_wrote_it() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(tmp.path(), "hello", &mock_context(), Source::Widget).unwrap();

        let today = Day::today_local().ymd();
        let content =
            fs::read_to_string(tmp.path().join("data/scrawl").join(format!("{today}.md"))).unwrap();
        assert!(content.contains("\"s\":\"widget\""));
    }

    #[test]
    fn test_save_scrawl_entry_appends() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(tmp.path(), "first", &mock_context(), Source::App).unwrap();
        save_scrawl_entry(tmp.path(), "second", &mock_context(), Source::App).unwrap();

        let today = Day::today_local().ymd();
        let file = tmp.path().join("data/scrawl").join(format!("{today}.md"));
        let content = fs::read_to_string(&file).unwrap();

        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("first"));
        assert!(lines[1].contains("second"));
    }

    /// Appending to a day as it was actually saved (macOS and Android side by side, old format
    /// with the full context at the end of each line) must not change the meaning of a single
    /// existing record.
    #[test]
    fn appending_to_a_legacy_day_leaves_every_old_entry_intact() {
        let legacy = [
            "- [00:21:05] うっざ {\"battery\":56,\"is_charging\":false,\"network_type\":\"WiFi\",\"os\":\"macos\",\"os_version\":\"26.3.1\",\"arch\":\"aarch64\",\"hostname\":\"MacBook\",\"locale\":\"ja_JP\"}",
            "- [09:18:56] ストレス溜まってる {\"location\":{\"latitude\":35.6761403,\"longitude\":139.5465634},\"os\":\"android\",\"arch\":\"aarch64\"}",
        ];
        let date = Day::parse_ymd("2026-08-04").unwrap();
        let tmp = TempDir::new().unwrap();
        let path = scrawl_file_path(tmp.path(), date);
        ensure_dir(&path).unwrap();
        fs::write(&path, format!("{}\n", legacy.join("\n"))).unwrap();

        save_scrawl_entry(
            tmp.path(),
            "あたらしい",
            &Context {
                os: "macos".to_string(),
                arch: "aarch64".to_string(),
                ..Context::default()
            },
            Source::App,
        )
        .unwrap();

        let today = Day::today_local();
        let entries = read_scrawl(tmp.path(), date).unwrap();
        assert_eq!(entries, legacy);
        // Today is a separate file, so the day above has not grown.
        assert_eq!(
            read_scrawl(tmp.path(), today).unwrap().len(),
            usize::from(today != date)
        );
    }
}
