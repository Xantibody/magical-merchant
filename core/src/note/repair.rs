use std::fs;
use std::path::Path;

use chrono::{DateTime, FixedOffset, Local, NaiveDateTime, TimeZone as _};

use crate::error::CoreError;
use crate::sync::conflict::conflict_copy_path;
use crate::utils::frontmatter::{self, NoteFrontmatter};
use crate::utils::fs::{ensure_dir, list_md_files, write_atomic};
use crate::utils::paths::{conflicts_dir, data_dir};

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

/// 古い版が `data/` に置いた競合コピーを `conflicts/` へ移す。移した件数を返す。
///
/// 控えは同期の走査からは外れていたが、ノート一覧は `data/notes/*.md` を
/// 素通しで拾うので、元のノートが消えたあとも残骸として並び続けていた。
/// タイムラインの控えは一覧には出ないが、走査の除外をやめた以上、
/// 置いたままだと次の同期で新しいファイルとして全端末へ配られる。
///
/// 探すのは `data/` 全体。走査が `data/` を丸ごと同期対象にする以上、
/// 残骸が配られるかどうかは置き場所によらない — 利用者が自分で切った
/// ディレクトリの下にある控えも、`notes/` にあるのと同じ扱いになる。
///
/// 中身は読まず `rename` するだけ。控えが壊れていても、ノートの形をして
/// いなくても運べる。起動時、最初の同期より前に呼ぶこと — あとで呼ぶと、
/// 除外をやめたスキャンが残骸を新しいノートとして全端末へ配ってしまう。
///
/// 1 件の失敗では止まらない。運べなかった控えは次の起動でまた試すだけで、
/// そのために残りの引っ越しを諦める理由はない。
pub(crate) fn relocate_conflict_copies(base_dir: &Path) -> usize {
    let data = data_dir(base_dir);
    let mut moved = 0;
    relocate_under(&data, &data, &conflicts_dir(base_dir), &mut moved);
    moved
}

fn relocate_under(root: &Path, current: &Path, conflicts: &Path, moved: &mut usize) {
    let Ok(entries) = fs::read_dir(current) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            relocate_under(root, &path, conflicts, moved);
            continue;
        }
        // 走査キーと同じ形にしてから読ませる。控えの置き場は
        // ダウンロードで降ってきたぶんと同じ `conflicts/<キー>/…` になる
        let Some(relative) = path
            .strip_prefix(root)
            .ok()
            .and_then(|key| key.to_str())
            .and_then(conflict_copy_path)
        else {
            continue;
        };
        let target = conflicts.join(relative);
        if ensure_dir(&target).is_err() || fs::rename(&path, &target).is_err() {
            continue;
        }
        *moved += 1;
    }
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
    use crate::utils::paths::{TIMELINE_DIR, notes_dir};
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

    // ──────────── 競合コピーの引っ越し ────────────

    fn seed_note(base: &Path, name: &str, content: &str) {
        let notes = notes_dir(base);
        fs::create_dir_all(&notes).unwrap();
        fs::write(notes.join(name), content).unwrap();
    }

    /// 古い版が置いた控えは `data/notes/` に残っている。一覧に並ぶし、
    /// 除外をやめたスキャンに乗れば他の端末へも配られる。
    #[test]
    fn conflict_copies_left_in_the_notes_directory_move_out() {
        let tmp = TempDir::new().unwrap();
        seed_note(tmp.path(), "20260320_033440.md", "the note itself");
        seed_note(
            tmp.path(),
            "20260320_033440.sync-conflict-20260511-031336.md",
            "first copy",
        );
        // 元のノートが既に消えている残骸。今の手元はほとんどこれ
        seed_note(
            tmp.path(),
            "20260101_000000.sync-conflict-20260511-031336..md",
            "orphan copy",
        );

        let moved = relocate_conflict_copies(tmp.path());

        assert_eq!(moved, 2);
        let notes: Vec<String> = list_md_files(&notes_dir(tmp.path()))
            .unwrap()
            .iter()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(notes, vec!["20260320_033440.md"]);
        let conflicts = conflicts_dir(tmp.path());
        assert_eq!(
            fs::read_to_string(conflicts.join("notes/20260320_033440/20260511-031336.md")).unwrap(),
            "first copy"
        );
        assert_eq!(
            fs::read_to_string(conflicts.join("notes/20260101_000000/20260511-031336.md")).unwrap(),
            "orphan copy"
        );
    }

    /// 起動のたびに走る。2 回目に動くものが残っていてはいけない。
    #[test]
    fn relocating_twice_moves_nothing_the_second_time() {
        let tmp = TempDir::new().unwrap();
        seed_note(
            tmp.path(),
            "20260320_033440.sync-conflict-20260511-031336.md",
            "copy",
        );

        assert_eq!(relocate_conflict_copies(tmp.path()), 1);
        let after_first = fs::read_to_string(
            conflicts_dir(tmp.path()).join("notes/20260320_033440/20260511-031336.md"),
        )
        .unwrap();

        assert_eq!(relocate_conflict_copies(tmp.path()), 0);
        assert_eq!(
            fs::read_to_string(
                conflicts_dir(tmp.path()).join("notes/20260320_033440/20260511-031336.md")
            )
            .unwrap(),
            after_first
        );
    }

    /// タイムラインの控えも同じ残骸。一覧には並ばない（日付でない名前は
    /// 捨てられる）が、走査の除外をやめた以上、置いたままだと次の同期で
    /// 新しいファイルとして全端末へ配られる。
    #[test]
    fn conflict_copies_left_in_the_timeline_directory_move_out() {
        let tmp = TempDir::new().unwrap();
        let timeline = data_dir(tmp.path()).join(TIMELINE_DIR);
        fs::create_dir_all(&timeline).unwrap();
        fs::write(timeline.join("2026-03-20.md"), "the day itself").unwrap();
        fs::write(
            timeline.join("2026-03-20.sync-conflict-20260511-031336..md"),
            "day copy",
        )
        .unwrap();

        assert_eq!(relocate_conflict_copies(tmp.path()), 1);

        assert!(timeline.join("2026-03-20.md").exists());
        assert!(
            !timeline
                .join("2026-03-20.sync-conflict-20260511-031336..md")
                .exists()
        );
        assert_eq!(
            fs::read_to_string(
                conflicts_dir(tmp.path()).join("timeline/2026-03-20/20260511-031336.md")
            )
            .unwrap(),
            "day copy"
        );
    }

    /// 控えが溜まるのは `notes/` と `timeline/` だけではない。`data/` の下は
    /// 丸ごと同期の走査対象なので、自分で切ったディレクトリに残った控えも
    /// 置いたままだと新しいファイルとして全端末へ配られる。
    #[test]
    fn conflict_copies_in_a_nested_directory_move_out() {
        let tmp = TempDir::new().unwrap();
        let done = data_dir(tmp.path()).join("projects/aaaa/done");
        fs::create_dir_all(&done).unwrap();
        fs::write(done.join("20260417_023550_461.md"), "the entry").unwrap();
        fs::write(
            done.join("20260417_023550_461.sync-conflict-20260511-031336..md"),
            "nested copy",
        )
        .unwrap();

        assert_eq!(relocate_conflict_copies(tmp.path()), 1);

        assert!(done.join("20260417_023550_461.md").exists());
        assert!(
            !done
                .join("20260417_023550_461.sync-conflict-20260511-031336..md")
                .exists()
        );
        assert_eq!(
            fs::read_to_string(
                conflicts_dir(tmp.path())
                    .join("projects/aaaa/done/20260417_023550_461/20260511-031336.md")
            )
            .unwrap(),
            "nested copy"
        );
    }

    /// 引っ越しは中身を見ない。控えが壊れていても、ノートで無くても運ぶ。
    #[test]
    fn a_note_that_is_not_a_conflict_copy_stays_put() {
        let tmp = TempDir::new().unwrap();
        seed_note(tmp.path(), "20260320_033440.md", "body");

        assert_eq!(relocate_conflict_copies(tmp.path()), 0);
        assert!(notes_dir(tmp.path()).join("20260320_033440.md").exists());
        assert!(!conflicts_dir(tmp.path()).exists());
    }
}
