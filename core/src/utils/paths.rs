use chrono::{DateTime, FixedOffset, NaiveDate};
use std::path::{Path, PathBuf};

pub const DATA_DIR: &str = "data";
pub const SCRAWL_DIR: &str = "scrawl";
pub const NOTES_DIR: &str = "notes";
pub const CODEX_DIR: &str = "codex";
pub const TEMPLATES_DIR: &str = "templates";
pub const GLYPHS_DIR: &str = "glyphs";

#[must_use]
pub fn data_dir(base_dir: &Path) -> PathBuf {
    base_dir.join(DATA_DIR)
}

#[must_use]
pub fn scrawl_file_path(base_dir: &Path, date: NaiveDate) -> PathBuf {
    data_dir(base_dir)
        .join(SCRAWL_DIR)
        .join(format!("{}.md", date.format("%Y-%m-%d")))
}

/// ファイル名は時刻が指しているその土地の壁時計で決まる。`FixedOffset` で
/// 受けるのは、frontmatter の `time` と同じ型でそのまま持ち回るため —
/// ここで端末のタイムゾーンに直すと、`+09:00` の記録を別の土地で作り直した
/// ときに ID の日付だけがずれる。
#[must_use]
pub fn note_file_path(base_dir: &Path, timestamp: DateTime<FixedOffset>) -> PathBuf {
    data_dir(base_dir)
        .join(NOTES_DIR)
        .join(format!("{}.md", timestamp.format("%Y%m%d_%H%M%S")))
}

#[must_use]
pub fn notes_dir(base_dir: &Path) -> PathBuf {
    data_dir(base_dir).join(NOTES_DIR)
}

/// テンプレの置き場。`data/` の中に置くのは、テンプレも同期されてほしいから。
/// 端末ごとに違うテンプレを持つと、ウィジェットから同じ名前を叩いても
/// 出てくるノートが端末で変わる。
#[must_use]
pub fn templates_dir(base_dir: &Path) -> PathBuf {
    data_dir(base_dir).join(TEMPLATES_DIR)
}

/// 特殊文字(グリフ)画像の置き場。`data/` の中に置くのは、画像も同期されて
/// ほしいから。`:236p:` と書いたノートが別の端末で文字のまま出ては、
/// 登録した意味がない。同期の走査は data 配下を拡張子で選ばず丸ごと辿る。
#[must_use]
pub fn glyphs_dir(base_dir: &Path) -> PathBuf {
    data_dir(base_dir).join(GLYPHS_DIR)
}

/// Codex(書き足し続ける文書)とその版の置き場。
///
/// `data/` の中に置くのは同期されてほしいから — 履歴が端末ごとに違っては
/// 蓄積にならない。`notes/` と分けるのは、Codex を知らない版の `list_notes`
/// が読まない場所に置くため。frontmatter のキーで分けると、知らない版が
/// 保存した瞬間にキーが落ちて普通のノートに戻る。
#[must_use]
pub fn codex_dir(base_dir: &Path) -> PathBuf {
    data_dir(base_dir).join(CODEX_DIR)
}

/// 書き換え前のノートの控えの置き場。
///
/// `data/` の外に置く。同期に載せると、書き換えのたびに控えが端末間を
/// 往復する。控えは戻すためのもので、共有するものではない。
#[must_use]
pub fn history_dir(base_dir: &Path) -> PathBuf {
    base_dir.join("history")
}

/// 競合で負けた側の控えの置き場。
///
/// `data/` の外に置く。同期の走査から外れるのはもちろん、ノート一覧が拾う
/// `data/notes/*.md` からも外れる。控えは戻すためのもので、書き続ける
/// ノートとして並ぶものではない。
#[must_use]
pub fn conflicts_dir(base_dir: &Path) -> PathBuf {
    base_dir.join("conflicts")
}

/// 地名キャッシュの置き場。
///
/// `data/` の外に置く。中身は座標から引き直せる派生物でしかなく、同期に
/// 載せると端末ごとに違う言語のキャッシュが往復するだけになる。
#[must_use]
pub fn place_cache_path(base_dir: &Path) -> PathBuf {
    base_dir.join("places.json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn test_scrawl_file_path() {
        let date = NaiveDate::from_ymd_opt(2026, 3, 20).unwrap();
        let path = scrawl_file_path(Path::new("/app"), date);
        assert_eq!(path, PathBuf::from("/app/data/scrawl/2026-03-20.md"));
    }

    #[test]
    fn test_note_file_path() {
        let ts = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 20, 14, 30, 45)
            .unwrap();
        let path = note_file_path(Path::new("/app"), ts);
        assert_eq!(path, PathBuf::from("/app/data/notes/20260320_143045.md"));
    }

    /// 同じ瞬間でも、時刻が名乗っているオフセットの壁時計で名前が決まる。
    /// 取り込みは元の記録の `+09:00` をそのまま渡すので、走らせた端末の
    /// タイムゾーンで日付が動かない。
    #[test]
    fn the_filename_follows_the_timestamps_own_offset() {
        let jst = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 20, 0, 30, 0)
            .unwrap();

        assert_eq!(
            note_file_path(Path::new("/app"), jst),
            PathBuf::from("/app/data/notes/20260320_003000.md")
        );
        assert_eq!(
            note_file_path(
                Path::new("/app"),
                jst.with_timezone(&chrono::Utc).fixed_offset()
            ),
            PathBuf::from("/app/data/notes/20260319_153000.md")
        );
    }

    #[test]
    fn test_notes_dir() {
        let path = notes_dir(Path::new("/app"));
        assert_eq!(path, PathBuf::from("/app/data/notes"));
    }

    /// テンプレも `data/` の中。同期の走査は data 配下を丸ごと辿るので、
    /// ここに置くだけで他の端末にも届く。
    #[test]
    fn templates_live_inside_the_synced_tree() {
        assert_eq!(
            templates_dir(Path::new("/app")),
            PathBuf::from("/app/data/templates")
        );
    }

    /// グリフ画像も `data/` の中。ノートと一緒に他の端末へ届く。
    #[test]
    fn glyphs_live_inside_the_synced_tree() {
        assert_eq!(
            glyphs_dir(Path::new("/app")),
            PathBuf::from("/app/data/glyphs")
        );
    }

    /// Codex の版は `data/` の中。人が刻んだ記録なので他の端末にも届く。
    #[test]
    fn codex_versions_live_inside_the_synced_tree() {
        assert_eq!(
            codex_dir(Path::new("/app")),
            PathBuf::from("/app/data/codex")
        );
    }

    /// 控えは history と同じく `data/` の外。中に置くと同期で往復するうえ、
    /// ノート一覧にも並ぶ。
    #[test]
    fn conflict_copies_sit_outside_the_synced_tree() {
        assert_eq!(
            conflicts_dir(Path::new("/app")),
            PathBuf::from("/app/conflicts")
        );
    }

    /// 同期されるのは `data/` 以下だけ。派生物のキャッシュはその外に置く。
    #[test]
    fn the_place_cache_sits_outside_the_synced_tree() {
        assert_eq!(
            place_cache_path(Path::new("/app")),
            PathBuf::from("/app/places.json")
        );
    }
}
