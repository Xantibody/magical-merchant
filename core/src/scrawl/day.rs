use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};

use crate::error::CoreError;
use crate::utils::device::{Context, DeviceIdentity, Source};
use crate::utils::frontmatter;
use crate::utils::markdown::{format_scrawl_line, split_context_json, split_time_prefix};

/// The list of devices used that day, placed at the head of the day file.
///
/// A day is not always one device. The real records have days that are Android in the
/// morning and Mac at night. Folding them into a single device loses which one wrote what.
#[derive(Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
struct DayFrontmatter {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    devices: Vec<DeviceIdentity>,
}

/// Per-entry information written at the end of the line.
#[derive(Debug, Default, Serialize, Deserialize)]
struct StoredContext {
    #[serde(flatten)]
    context: Context,
    /// Index into `devices`. 1-based; 0 (omitted) means "device unknown".
    ///
    /// With a 0-based index, an old entry that recorded no device cannot be told apart from
    /// one "written on the first device". The former would take on the latter's device.
    #[serde(default, rename = "d", skip_serializing_if = "is_unknown_device")]
    device: usize,
    /// Which entry point wrote it. Scrawl is written by `app`, `cli` and `widget`; `Source`
    /// also spells `mcp` and `import`, which only notes use.
    ///
    /// A one-character key, like `d`. Against a body of a few dozen characters per line,
    /// adding `"source":"widget"` to every line stops the file being readable Markdown.
    /// Not added to entries that did not record it: rewriting an existing day file moves
    /// its content hash, and the sync runs over the whole file.
    #[serde(default, rename = "s", skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

#[allow(clippy::trivially_copy_pass_by_ref)] // skip_serializing_if only passes a reference
const fn is_unknown_device(device: &usize) -> bool {
    *device == 0
}

/// One day of Scrawl. On disk it is the compact form with device information gathered at
/// the head; on read it is restored to the pre-split "line with its full context at the end".
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct DayLog {
    devices: Vec<DeviceIdentity>,
    entries: Vec<String>,
}

impl DayLog {
    /// Reads both formats, with and without frontmatter. Broken frontmatter does not throw
    /// the body away. Giving up the device information beats making the records unreadable.
    pub(crate) fn parse(content: &str) -> Self {
        let (devices, body) = frontmatter::parse::<DayFrontmatter>(content)
            .map_or((Vec::new(), content), |(fm, body)| (fm.devices, body));

        Self {
            devices,
            entries: split_entries(body),
        }
    }

    pub(crate) fn render(&self) -> Result<String, CoreError> {
        let mut body = self.entries.join("\n");
        body.push('\n');

        if self.devices.is_empty() {
            return Ok(body);
        }
        frontmatter::render(
            &DayFrontmatter {
                devices: self.devices.clone(),
            },
            &format!("\n{body}"),
        )
    }

    /// Adds one record. Device information is reused when already listed, and added to the
    /// list when seen for the first time.
    ///
    /// With `source` set to `None` the end of the line does not change by a single byte.
    pub(crate) fn push(
        &mut self,
        text: &str,
        timestamp: DateTime<Local>,
        context: &Context,
        source: Option<Source>,
    ) {
        let stored = StoredContext {
            context: context.volatile(),
            device: self.device_number(&context.identity()),
            source: source.map(|s| s.as_str().to_string()),
        };
        self.entries
            .push(format_scrawl_line(text, timestamp, &stored));
    }

    /// Restores lines to their pre-split form. Callers never see how the disk is laid out.
    pub(crate) fn expanded(&self) -> Vec<String> {
        self.entries.iter().map(|e| self.expand(e)).collect()
    }

    /// One item of `expanded()`. A caller that checks a single line should not pay for
    /// rebuilding the whole day.
    pub(crate) fn expanded_at(&self, index: usize) -> Option<String> {
        self.entries.get(index).map(|e| self.expand(e))
    }

    pub(crate) const fn entries_mut(&mut self) -> &mut Vec<String> {
        &mut self.entries
    }

    /// The entries with device information left folded. For search, which reads only the body.
    pub(crate) fn into_entries(self) -> Vec<String> {
        self.entries
    }

    pub(crate) const fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn device_number(&mut self, identity: &DeviceIdentity) -> usize {
        if *identity == DeviceIdentity::default() {
            return 0;
        }
        let at = self.devices.iter().position(|d| d == identity);
        at.unwrap_or_else(|| {
            self.devices.push(identity.clone());
            self.devices.len() - 1
        }) + 1
    }

    fn expand(&self, entry: &str) -> String {
        let Some((prefix, rest)) = split_time_prefix(entry) else {
            return entry.to_string();
        };
        let Some(json) = split_context_json(rest) else {
            return entry.to_string();
        };
        let Ok(stored) = serde_json::from_str::<StoredContext>(json) else {
            return entry.to_string();
        };
        // An entry that wrote no device (old format) already has a complete end of line.
        let Some(identity) = self.devices.get(stored.device.wrapping_sub(1)) else {
            return entry.to_string();
        };

        let text = &rest[..rest.len() - json.len()];
        // Only the device information is restored. `d` stays folded (0 is not written), and `s`
        // is a record of the line itself, not of the device state, so it stays on the expanded
        // line too. Dropping it would hide the origin from readers (MCP output, the line's meta).
        let full = StoredContext {
            context: stored.context.with_identity(identity),
            device: 0,
            source: stored.source,
        };
        serde_json::to_string(&full).map_or_else(
            |_| entry.to_string(),
            |full| format!("{prefix}{text}{full}"),
        )
    }
}

/// An entry runs from a line starting with "- [" to the next "- [" (the body may contain newlines)
pub(crate) fn split_entries(content: &str) -> Vec<String> {
    let mut entries: Vec<String> = Vec::new();
    for line in content.lines() {
        if line.starts_with("- [") || entries.is_empty() {
            if line.is_empty() {
                continue;
            }
            entries.push(line.to_string());
        } else if let Some(last) = entries.last_mut() {
            last.push('\n');
            last.push_str(line);
        }
    }
    // Going through to_string() to drop the trailing whitespace allocates once more per entry.
    for entry in &mut entries {
        entry.truncate(entry.trim_end().len());
    }
    entries
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::device::NetworkType;
    use chrono::TimeZone;

    fn at(hour: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 4, 30, hour, 0, 0).unwrap()
    }

    fn mac() -> Context {
        Context {
            battery: Some(56),
            network_type: Some(NetworkType::WiFi),
            os: "macos".to_string(),
            os_version: Some("26.3.1".to_string()),
            arch: "aarch64".to_string(),
            hostname: Some("MacBook".to_string()),
            locale: Some("ja_JP".to_string()),
            ..Context::default()
        }
    }

    fn android() -> Context {
        Context {
            battery: Some(30),
            os: "android".to_string(),
            arch: "aarch64".to_string(),
            ..Context::default()
        }
    }

    #[test]
    fn a_single_device_day_writes_its_identity_once() {
        let mut day = DayLog::default();
        day.push("first", at(9), &mac(), None);
        day.push("second", at(10), &mac(), None);

        let rendered = day.render().unwrap();

        assert_eq!(rendered.matches("macos").count(), 1);
        assert!(rendered.contains("- [09:00:00] first {\"battery\":56"));
        assert!(!rendered.contains("\"hostname\""));
    }

    #[test]
    fn a_day_split_across_devices_keeps_both() {
        let mut day = DayLog::default();
        day.push("on the phone", at(9), &android(), None);
        day.push("at the desk", at(21), &mac(), None);

        let reread = DayLog::parse(&day.render().unwrap());
        let entries = reread.expanded();

        assert!(entries[0].contains("\"os\":\"android\""));
        assert!(entries[1].contains("\"os\":\"macos\""));
        assert!(entries[1].contains("\"hostname\":\"MacBook\""));
    }

    #[test]
    fn reading_it_back_reproduces_the_full_context() {
        let mut day = DayLog::default();
        day.push("hello", at(9), &mac(), None);

        let entries = DayLog::parse(&day.render().unwrap()).expanded();

        let expected = format_scrawl_line("hello", at(9), &mac());
        assert_eq!(entries, vec![expected]);
    }

    #[test]
    fn entries_written_before_the_split_are_returned_untouched() {
        let old = "- [09:00:00] legacy {\"battery\":80,\"os\":\"macos\",\"arch\":\"aarch64\"}\n";

        let day = DayLog::parse(old);

        assert_eq!(day.expanded(), vec![old.trim_end()]);
    }

    #[test]
    fn a_new_entry_does_not_claim_the_device_of_older_ones() {
        let old = "- [09:00:00] legacy {\"battery\":80}\n";
        let mut day = DayLog::parse(old);
        day.push("fresh", at(10), &mac(), None);

        let entries = DayLog::parse(&day.render().unwrap()).expanded();

        assert!(!entries[0].contains("macos"));
        assert!(entries[1].contains("macos"));
    }

    #[test]
    fn an_entry_without_any_context_survives_a_round_trip() {
        let mut day = DayLog::default();
        day.push("bare", at(9), &Context::default(), None);

        let rendered = day.render().unwrap();

        assert_eq!(rendered, "- [09:00:00] bare\n");
        assert_eq!(
            DayLog::parse(&rendered).expanded(),
            vec!["- [09:00:00] bare"]
        );
    }

    /// The line of an entry that names no entry point differs by not a single byte from
    /// before `s` existed. The day file is the unit of sync itself: if the end of a line moves
    /// by one character, every device sees "that day changed" and transfers it again.
    #[test]
    fn an_entry_that_names_no_source_is_written_exactly_as_before() {
        let mut day = DayLog::default();
        day.push("bare", at(9), &Context::default(), None);
        day.push("with a device", at(10), &mac(), None);

        let rendered = day.render().unwrap();

        assert!(!rendered.contains("\"s\""));
        assert!(rendered.contains("- [09:00:00] bare\n"));
        assert!(rendered.contains(
            "- [10:00:00] with a device {\"battery\":56,\"network_type\":\"WiFi\",\"d\":1}"
        ));
    }

    /// A named source is added at the end of the line as a one-character key. Reading it back
    /// does not lose it: the expansion that restores device information must not drop `s`.
    #[test]
    fn an_entry_carries_the_source_that_wrote_it() {
        let mut day = DayLog::default();
        day.push("from the widget", at(9), &android(), Some(Source::Widget));

        let rendered = day.render().unwrap();

        assert!(rendered.contains("\"s\":\"widget\""));
        assert!(DayLog::parse(&rendered).expanded()[0].ends_with(
            "{\"battery\":30,\"os\":\"android\",\"arch\":\"aarch64\",\"s\":\"widget\"}"
        ));
    }

    #[test]
    fn multiline_entries_stay_one_entry() {
        let mut day = DayLog::default();
        day.push("line1\nline2", at(9), &mac(), None);

        let entries = DayLog::parse(&day.render().unwrap()).expanded();

        assert_eq!(entries.len(), 1);
        assert!(entries[0].contains("line1\nline2"));
    }

    #[test]
    fn the_same_device_is_listed_once_however_often_it_writes() {
        let mut day = DayLog::default();
        for hour in 9..15 {
            day.push("tick", at(hour), &mac(), None);
        }

        assert_eq!(day.devices.len(), 1);
    }

    /// A day of blank lines only is a day with no records. It must not create one empty entry.
    #[test]
    fn an_empty_body_has_no_entries() {
        assert!(split_entries("").is_empty());
        assert!(split_entries("\n\n\n").is_empty());
    }

    /// A body whose first line does not start with `- [`. An old record without a time is
    /// picked up as the first entry instead of dropped, and the following lines continue it.
    #[test]
    fn a_body_that_does_not_start_with_a_bullet_keeps_its_first_line() {
        let entries = split_entries("plain first\nstill first\n- [10:00:00] second\n");

        assert_eq!(
            entries,
            vec!["plain first\nstill first", "- [10:00:00] second"]
        );
    }

    /// A line that points at a number not in the device list is returned untouched, as a
    /// broken line. That is better than returning it with another device's information.
    #[test]
    fn an_entry_pointing_past_the_device_list_is_returned_unchanged() {
        let mut day = DayLog::default();
        day.push("known", at(9), &mac(), None);
        let stray = "- [10:00:00] stray {\"battery\":1,\"d\":5}";

        assert_eq!(day.devices.len(), 1);
        assert_eq!(day.expand(stray), stray);
    }

    #[test]
    fn a_battery_reading_is_kept_per_entry() {
        let mut day = DayLog::default();
        day.push("morning", at(9), &mac(), None);
        day.push(
            "evening",
            at(21),
            &Context {
                battery: Some(12),
                ..mac()
            },
            None,
        );

        let entries = DayLog::parse(&day.render().unwrap()).expanded();

        assert!(entries[0].contains("\"battery\":56"));
        assert!(entries[1].contains("\"battery\":12"));
        assert_eq!(day.devices.len(), 1);
    }
}
