use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};

use crate::error::CoreError;
use crate::utils::device::{Context, DeviceIdentity, Source};
use crate::utils::frontmatter;
use crate::utils::markdown::{format_timeline_line, split_context_json, split_time_prefix};

/// 日ファイルの先頭に置く、その日に使われた端末の一覧。
///
/// 1 日 1 端末とは限らない。実際の記録には、朝は Android・夜は Mac という日が
/// ある。単一の端末として畳むと、どちらで書いたのか分からなくなる。
#[derive(Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
struct DayFrontmatter {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    devices: Vec<DeviceIdentity>,
}

/// 行末に書く、そのエントリだけの情報。
#[derive(Debug, Default, Serialize, Deserialize)]
struct StoredContext {
    #[serde(flatten)]
    context: Context,
    /// `devices` の何番目か。1 始まりで、0（省略）は「端末が分からない」。
    ///
    /// 0 始まりにすると、端末を記録していない旧いエントリと「1 台目で書いた」
    /// エントリを見分けられない。前者に後者の端末が付いてしまう。
    #[serde(default, rename = "d", skip_serializing_if = "is_unknown_device")]
    device: usize,
    /// どの入り口で書かれたか(`app` / `cli` / `mcp` / `widget`)。
    ///
    /// `d` と同じく 1 文字のキーにする。1 行あたり数十文字の本文に対して
    /// `"source":"widget"` を毎行足すと、読める Markdown ではなくなる。
    /// 記録していないエントリには付けない — 既存の日ファイルが書き換わると
    /// 内容ハッシュが動いて同期が丸ごと走る。
    #[serde(default, rename = "s", skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

#[allow(clippy::trivially_copy_pass_by_ref)] // skip_serializing_if は参照しか渡さない
const fn is_unknown_device(device: &usize) -> bool {
    *device == 0
}

/// 1 日ぶんのタイムライン。ディスク上は端末情報を先頭にまとめた圧縮形、
/// 読み出しでは分割前と同じ「行末に完全なコンテキストが載った行」に戻す。
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct DayLog {
    devices: Vec<DeviceIdentity>,
    entries: Vec<String>,
}

impl DayLog {
    /// frontmatter の有無どちらの形式も読む。frontmatter が壊れていても
    /// 本文を捨てはしない。記録が読めなくなるくらいなら端末情報を諦める。
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

    /// 記録を 1 件足す。端末情報は既出なら使い回し、初めてなら一覧に加える。
    ///
    /// `source` が `None` なら行末は今までと 1 バイトも変わらない。
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
            .push(format_timeline_line(text, timestamp, &stored));
    }

    /// 分割前と同じ形の行に戻す。呼び出し側にディスク上の都合は見せない。
    pub(crate) fn expanded(&self) -> Vec<String> {
        self.entries.iter().map(|e| self.expand(e)).collect()
    }

    pub(crate) const fn entries_mut(&mut self) -> &mut Vec<String> {
        &mut self.entries
    }

    /// 端末情報を戻さないままエントリだけ取る。本文しか見ない検索が使う。
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
        // 端末を書いていないエントリ（旧形式）は行末がすでに完全な形。
        let Some(identity) = self.devices.get(stored.device.wrapping_sub(1)) else {
            return entry.to_string();
        };

        let text = &rest[..rest.len() - json.len()];
        // 戻すのは端末情報だけ。`d` は畳んだまま(0 は書かれない)で、`s` は
        // 端末の状態ではなく行そのものの記録なので展開後の行にも残す —
        // 落とすと、読む側(MCP 出力・行のメタ表示)から出所が消える。
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

/// エントリは "- [" で始まる行から次の "- [" まで（本文に改行を含み得る）
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
    // 末尾を落とすのに to_string() を挟むと 1 エントリにつきもう 1 回確保する。
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

        let expected = format_timeline_line("hello", at(9), &mac());
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

    /// 入り口を名乗らないエントリの行は、`s` を足す前と 1 バイトも違わない。
    /// 日ファイルは同期の単位そのもので、行末が 1 文字でも動けば全端末が
    /// 「その日は変わった」と見て転送し直す。
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

    /// 名乗ったぶんだけ、行末に 1 文字のキーで付く。読み戻しても消えない —
    /// 端末情報を戻す展開は `s` を落としてはいけない。
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
