use std::path::Path;

use chrono::{DateTime, Utc};

/// 競合コピーだと分かる印。名前を組むのも読み戻すのもこのファイルだけなので、
/// 綴りが 2 か所に割れることはない。
const CONFLICT_MARKER: &str = ".sync-conflict-";

#[must_use]
pub fn conflict_filename(key: &str, timestamp: DateTime<Utc>) -> String {
    let path = Path::new(key);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("md");
    let parent = path.parent().and_then(|p| p.to_str()).unwrap_or("");
    let ts = timestamp.format("%Y%m%d-%H%M%S");

    if parent.is_empty() {
        format!("{stem}{CONFLICT_MARKER}{ts}.{ext}")
    } else {
        format!("{parent}/{stem}{CONFLICT_MARKER}{ts}.{ext}")
    }
}

/// `conflict_filename` の逆。控えのキーから、元のキーと控えを取った時刻を返す。
/// 競合コピーの名前でなければ `None`。
///
/// 拡張子は `Path` に読ませる。サーバー駆動同期以前の控えには
/// `….sync-conflict-20260511-031336..md` のように点が 1 つ多い名前があり、
/// 素朴に最初の `.` で切ると時刻に点が残る。
fn conflict_copy_origin(key: &str) -> Option<(String, String)> {
    let (stem_path, rest) = key.split_once(CONFLICT_MARKER)?;
    let rest = Path::new(rest);
    let ext = rest.extension().and_then(|e| e.to_str()).unwrap_or("md");
    let timestamp = rest
        .file_stem()
        .and_then(|s| s.to_str())?
        .trim_end_matches('.');
    Some((format!("{stem_path}.{ext}"), timestamp.to_string()))
}

/// 控えを置く、控え置き場からの相対パス。競合コピーの名前でなければ `None`。
///
/// 元のキーから拡張子を落としてディレクトリにし、その下に時刻で置く
/// (`notes/20260320_033440/20260511-031336.md`)。`history/<stem>/<日時>.md`
/// と同じ形なので、1 本のノートの控えが何度増えても 1 か所に集まる。
#[must_use]
pub fn conflict_copy_path(key: &str) -> Option<String> {
    let (original, timestamp) = conflict_copy_origin(key)?;
    let path = Path::new(&original);
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("md");
    let dir = original.strip_suffix(&format!(".{ext}"))?;
    Some(format!("{dir}/{timestamp}.{ext}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn conflict_filename_with_parent() {
        let ts = Utc.with_ymd_and_hms(2026, 4, 22, 12, 0, 0).unwrap();
        assert_eq!(
            conflict_filename("notes/test.md", ts),
            "notes/test.sync-conflict-20260422-120000.md"
        );
    }

    #[test]
    fn conflict_filename_without_parent() {
        let ts = Utc.with_ymd_and_hms(2026, 4, 22, 12, 0, 0).unwrap();
        assert_eq!(
            conflict_filename("test.md", ts),
            "test.sync-conflict-20260422-120000.md"
        );
    }

    #[test]
    fn conflict_filename_nested_path() {
        let ts = Utc.with_ymd_and_hms(2026, 4, 22, 12, 0, 0).unwrap();
        assert_eq!(
            conflict_filename("notes/archive/2026/note.md", ts),
            "notes/archive/2026/note.sync-conflict-20260422-120000.md"
        );
    }

    /// 控えの置き場を決めるには、名前から元のキーが読み戻せないといけない。
    /// 親付きのキーでも親ごと戻る。
    #[test]
    fn a_generated_name_reads_back_to_the_key_it_came_from() {
        let ts = Utc.with_ymd_and_hms(2026, 5, 11, 3, 13, 36).unwrap();
        for key in [
            "notes/20260320_033440.md",
            "note.md",
            "notes/archive/2026/note.md",
            "glyphs/236p.png",
        ] {
            assert_eq!(
                conflict_copy_origin(&conflict_filename(key, ts)),
                Some((key.to_string(), "20260511-031336".to_string())),
                "{key}"
            );
        }
    }

    #[test]
    fn a_name_without_the_marker_is_not_a_conflict_copy() {
        assert_eq!(conflict_copy_origin("notes/20260320_033440.md"), None);
        assert_eq!(conflict_copy_path("notes/20260320_033440.md"), None);
    }

    /// 控えは元のノートごとに 1 ディレクトリ。history と同じ形。
    #[test]
    fn a_copy_is_filed_under_the_note_it_came_from() {
        assert_eq!(
            conflict_copy_path("notes/20260320_033440.sync-conflict-20260511-031336.md"),
            Some("notes/20260320_033440/20260511-031336.md".to_string())
        );
        assert_eq!(
            conflict_copy_path("notes/archive/2026/note.sync-conflict-20260422-120000.md"),
            Some("notes/archive/2026/note/20260422-120000.md".to_string())
        );
    }

    /// 手元に残っている古い控えは点が 1 つ多い。時刻にその点を混ぜたまま
    /// ディレクトリ名にすると、同じノートの控えが 2 か所に分かれる。
    #[test]
    fn an_old_double_dotted_name_still_reads_back() {
        assert_eq!(
            conflict_copy_path("notes/20260320_033440.sync-conflict-20260511-031336..md"),
            Some("notes/20260320_033440/20260511-031336.md".to_string())
        );
    }
}
