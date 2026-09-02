use std::fs;
use std::path::Path;

use chrono::{DateTime, FixedOffset, Local, NaiveDateTime, TimeZone as _};

use crate::error::CoreError;
use crate::utils::frontmatter::{self, NoteFrontmatter};
use crate::utils::fs::{list_md_files, write_atomic};

/// 編集画面が frontmatter ごと Milkdown に通していた時期に保存されたノートは、
/// 本文の先頭に「化けたメタデータ」を抱えている。開始区切りの `---` は `***` に、
/// YAML はエスケープ付きの平文(`tags: \[]`)に、終了区切りは直前の行と合わさって
/// setext 見出しの下線(`------`)になった塊で、frontmatter の time も編集時刻で
/// 上書きされている。その塊を取り除き、time をファイル名の作成時刻へ戻す。
///
/// 該当しないファイルには一切書き込まない。全ファイルを書き直すと
/// 内容ハッシュが変わった扱いになり、同期が無変更のノートまで転送し直すことになる。
pub(crate) fn repair_all(notes_dir: &Path) -> Result<usize, CoreError> {
    let mut repaired = 0;
    for entry in list_md_files(notes_dir)? {
        let path = entry.path();
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok((fm, body)) = frontmatter::parse::<NoteFrontmatter>(&content) else {
            continue;
        };
        let Some(clean_body) = strip_mangled_metadata(body) else {
            continue;
        };

        let filename = entry.file_name().to_string_lossy().to_string();
        let fixed = NoteFrontmatter {
            time: filename_time(&filename).unwrap_or(fm.time),
            ..fm
        };
        write_atomic(&path, frontmatter::render(&fixed, &clean_body)?)?;
        repaired += 1;
    }
    Ok(repaired)
}

/// 本文先頭の化けたメタデータ塊を取り除いた本文を返す。塊が無ければ `None`。
///
/// `***` も `time:` で始まる行もユーザーが書き得るので、開始区切り・時刻として
/// 読める time 行・ダッシュだけの終了行、の三点が揃ったときだけ塊とみなす。
fn strip_mangled_metadata(body: &str) -> Option<String> {
    let lines: Vec<&str> = body.lines().collect();
    let mut i = 0;

    while lines.get(i).is_some_and(|l| l.trim().is_empty()) {
        i += 1;
    }
    if lines.get(i) != Some(&"***") {
        return None;
    }
    i += 1;
    while lines.get(i).is_some_and(|l| l.trim().is_empty()) {
        i += 1;
    }

    let time_value = lines.get(i)?.strip_prefix("time: ")?;
    DateTime::parse_from_rfc3339(time_value.trim()).ok()?;

    // 終了区切りの成れの果て: ダッシュ 3 本以上だけの行
    let is_dash_line = |l: &str| l.len() >= 3 && l.bytes().all(|b| b == b'-');
    while i < lines.len() && !is_dash_line(lines[i]) {
        i += 1;
    }
    if i == lines.len() {
        return None;
    }
    i += 1;

    // 塊の直後に残った空行と `<br />`(空段落の成れの果て)も本文には要らない
    while lines
        .get(i)
        .is_some_and(|l| l.trim().is_empty() || l.trim() == "<br />")
    {
        i += 1;
    }

    Some(lines[i..].join("\n"))
}

/// `20260503_153910.md` のようなファイル名から作成時刻を読む。
/// frontmatter の time は編集で上書きされてきた履歴があるが、
/// ファイル名は作成時に振られたまま変わらない。
fn filename_time(filename: &str) -> Option<DateTime<FixedOffset>> {
    let stem = filename.get(..15)?;
    let naive = NaiveDateTime::parse_from_str(stem, "%Y%m%d_%H%M%S").ok()?;
    let local = Local.from_local_datetime(&naive).earliest()?;
    Some(local.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// 実際に壊れていたファイルと同じ形の再現。
    const MANGLED: &str = concat!(
        "---\n",
        "time: 2026-08-09T20:38:50.370362+09:00\n",
        "tags:\n",
        "- keep\n",
        "context:\n",
        "  battery: 100\n",
        "  is_charging: true\n",
        "---\n",
        "***\n",
        "\n",
        "time: 2026-05-03T15:47:06.544569369+09:00\n",
        "tags: \\[]\n",
        "context:\n",
        "battery: 64\n",
        "is\\_charging: false\n",
        "os\\_version: '26.6'\n",
        "locale: ja\\_JP\n",
        "--------------\n",
        "\n",
        "<br />\n",
        "\n",
        "<br />\n",
        "\n",
        "# EVOJについて\n",
        "本文はここから\n",
    );

    fn seed(dir: &Path, name: &str, content: &str) {
        fs::write(dir.join(name), content).unwrap();
    }

    #[test]
    fn repairs_a_mangled_note_and_restores_the_filename_time() {
        let tmp = TempDir::new().unwrap();
        seed(tmp.path(), "20260503_153910.md", MANGLED);

        let repaired = repair_all(tmp.path()).unwrap();

        assert_eq!(repaired, 1);
        let content = fs::read_to_string(tmp.path().join("20260503_153910.md")).unwrap();
        let (fm, body) = frontmatter::parse::<NoteFrontmatter>(&content).unwrap();
        assert_eq!(body, "# EVOJについて\n本文はここから");
        assert_eq!(fm.tags, vec!["keep"]);
        assert!(fm.context.is_some());
        let expected = Local
            .with_ymd_and_hms(2026, 5, 3, 15, 39, 10)
            .single()
            .unwrap();
        assert_eq!(fm.time, expected);
    }

    #[test]
    fn repair_is_idempotent() {
        let tmp = TempDir::new().unwrap();
        seed(tmp.path(), "20260503_153910.md", MANGLED);

        repair_all(tmp.path()).unwrap();
        let after_first = fs::read_to_string(tmp.path().join("20260503_153910.md")).unwrap();
        let repaired = repair_all(tmp.path()).unwrap();

        assert_eq!(repaired, 0);
        let after_second = fs::read_to_string(tmp.path().join("20260503_153910.md")).unwrap();
        assert_eq!(after_first, after_second);
    }

    /// ユーザーが本文に書いた `***`(水平線)を化けたメタデータと
    /// 取り違えて消してはいけない。
    #[test]
    fn a_user_written_horizontal_rule_is_not_metadata() {
        let tmp = TempDir::new().unwrap();
        let content = "---\ntime: 2026-04-30T02:01:21+09:00\ntags: []\n---\nあ\n\n***\n\n本文\n";
        seed(tmp.path(), "20260430_020116.md", content);

        let repaired = repair_all(tmp.path()).unwrap();

        assert_eq!(repaired, 0);
        assert_eq!(
            fs::read_to_string(tmp.path().join("20260430_020116.md")).unwrap(),
            content
        );
    }

    /// `***` 直後でも、日時として読めない行が続くなら塊ではない。
    #[test]
    fn a_rule_followed_by_plain_text_is_left_alone() {
        let tmp = TempDir::new().unwrap();
        let content =
            "---\ntime: 2026-04-30T02:01:21+09:00\ntags: []\n---\n***\n\ntime: 未定\n---\n";
        seed(tmp.path(), "20260430_020116.md", content);

        assert_eq!(repair_all(tmp.path()).unwrap(), 0);
    }

    /// 同期の衝突ファイル名でも先頭のタイムスタンプは読める。
    #[test]
    fn filename_time_reads_conflict_filenames() {
        let time = filename_time("20260320_033440.sync-conflict-20260511-031336..md").unwrap();
        let expected = Local
            .with_ymd_and_hms(2026, 3, 20, 3, 34, 40)
            .single()
            .unwrap();
        assert_eq!(time, expected);
    }

    #[test]
    fn filename_time_rejects_foreign_names() {
        assert!(filename_time("readme.md").is_none());
    }

    #[test]
    fn a_missing_directory_repairs_nothing() {
        let tmp = TempDir::new().unwrap();
        assert_eq!(repair_all(&tmp.path().join("nope")).unwrap(), 0);
    }
}
