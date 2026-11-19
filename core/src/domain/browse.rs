//! Browse, and the newest records the search field opens on.

use std::path::Path;

use crate::domain::note::list;
use crate::domain::search::{SNIPPET_CONTEXT, SearchFilter, SearchHit, first_line, scrawl_hits};
use crate::error::CoreError;
use crate::utils::text::head;

/// Return every Scrawl entry and every Note / Codex note as one sequence, newest first.
///
/// Since it does not narrow by text, it differs from [`search_all`](crate::search_all) in
/// three ways. The snippet is the first 40 characters of the body rather than the match
/// position, `match_start` / `match_len` are always `None` (there is no notion of a match),
/// and **the count is not capped**: the Browse screen counts per kind / tag / period from
/// the list returned here, so a cap would make the chip numbers lie.
///
/// The scan costs the same as calling `search_all` with no query (every Scrawl day plus
/// every note's body). Call it only once, when the screen opens.
pub fn browse_all(base_dir: &Path) -> Result<Vec<SearchHit>, CoreError> {
    // A scan with no needle and no scope is a "let everything through" scan. It uses the
    // same entry as search
    let mut hits = scrawl_hits(base_dir, "", &[], &SearchFilter::default(), None)?;

    // An unreadable note comes with an empty body (`scan`). Its title and snippet become
    // an empty row, but one note must not fail the whole list: same policy as `search_all`
    list::scan(base_dir, |note, body| {
        hits.push(SearchHit {
            kind: note.kind.into(),
            title: first_line(&note.preview).to_string(),
            snippet: head(body, SNIPPET_CONTEXT),
            date: note.time.map(|t| t.day().ymd()).unwrap_or_default(),
            filename: Some(note.filename),
            index: None,
            tags: note.tags,
            match_start: None,
            match_len: None,
        });
    })?;

    hits.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(hits)
}

/// The newest `limit` records, in [`browse_all`]'s order: what the search field shows before
/// a word is typed.
///
/// It reads everything `browse_all` reads. A note's date is its frontmatter `time`, not its
/// filename, so the newest cannot be known without opening every note. What it saves is the
/// trip to the screen: the field shows a few rows, and a year of records is thousands, each
/// carried as a title, an excerpt and its tags.
pub fn recent_records(base_dir: &Path, limit: usize) -> Result<Vec<SearchHit>, CoreError> {
    let mut hits = browse_all(base_dir)?;
    hits.truncate(limit);
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::note::Provenance;
    use crate::domain::search::{HitKind, MAX_HITS};
    use crate::utils::clock::Day;
    use crate::utils::device::{Context, Source};
    use crate::{create_draft_codex, create_draft_note, save_scrawl_entry};
    use tempfile::TempDir;

    fn context() -> Context {
        Context::default()
    }

    /// A plain note to browse. Provenance is not listed, so none is declared.
    fn draft(tmp: &TempDir, body: &str, tags: &[String]) -> Result<std::path::PathBuf, CoreError> {
        create_draft_note(tmp.path(), body, tags, &context(), Provenance::default())
    }

    /// Write one line on a fixed date. `save_scrawl_entry` can only write to today.
    fn write_day(tmp: &TempDir, date: Day, text: &str) {
        let dir = tmp.path().join("data/scrawl");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{}.md", date.ymd())),
            format!("- [09:00:00] {text}\n"),
        )
        .unwrap();
    }

    #[test]
    fn browsing_an_empty_tree_returns_nothing() {
        let tmp = TempDir::new().unwrap();

        assert!(browse_all(tmp.path()).unwrap().is_empty());
    }

    /// The Browse screen lists everything even with no filter chosen. Entries and notes
    /// mix into one sequence, newest first.
    #[test]
    fn browsing_lists_scrawl_entries_and_notes_newest_first() {
        let tmp = TempDir::new().unwrap();
        write_day(&tmp, Day::new(2025, 1, 1).unwrap(), "古い記録");
        draft(&tmp, "今日のノート", &[]).unwrap();

        let hits = browse_all(tmp.path()).unwrap();

        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].kind, HitKind::Note);
        assert_eq!(hits[0].title, "今日のノート");
        assert_eq!(hits[1].kind, HitKind::Scrawl);
        assert_eq!(hits[1].title, "古い記録");
        assert_eq!(hits[1].index, Some(0));
    }

    /// The search field shows the newest few. They are the head of what Browse lists, so the
    /// two screens never disagree about what is newest.
    #[test]
    fn recent_records_are_the_head_of_the_browse_list() {
        let tmp = TempDir::new().unwrap();
        write_day(&tmp, Day::new(2025, 1, 1).unwrap(), "古い記録");
        write_day(&tmp, Day::new(2025, 1, 2).unwrap(), "次の日の記録");
        draft(&tmp, "今日のノート", &[]).unwrap();

        let recent = recent_records(tmp.path(), 2).unwrap();

        let all = browse_all(tmp.path()).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(recent, all[..2]);
    }

    /// A Codex says it is a Codex, because it opens on a different surface.
    #[test]
    fn a_browsed_codex_says_so() {
        let tmp = TempDir::new().unwrap();
        create_draft_codex(
            tmp.path(),
            "育てる文書",
            &[],
            &context(),
            Provenance::default(),
        )
        .unwrap();

        let hits = browse_all(tmp.path()).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, HitKind::Codex);
    }

    /// The chips show tags with counts. They cannot be counted if the source drops the tags.
    #[test]
    fn browsing_carries_the_tags_of_each_record() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(tmp.path(), "走った #run", &context(), Source::App).unwrap();
        draft(&tmp, "走る計画", &["Plan".to_string()]).unwrap();

        let hits = browse_all(tmp.path()).unwrap();

        let entry = hits.iter().find(|h| h.kind == HitKind::Scrawl).unwrap();
        assert_eq!(entry.tags, vec!["run"]);
        let note = hits.iter().find(|h| h.kind == HitKind::Note).unwrap();
        assert_eq!(note.tags, vec!["Plan"]);
    }

    /// The snippet is the first 40 characters of the body. The same number as the search
    /// snippet, and anything beyond gets an ellipsis in the same manner.
    #[test]
    fn a_browsed_snippet_is_the_first_forty_chars_of_the_body() {
        let snippet_of = |len: usize| {
            let tmp = TempDir::new().unwrap();
            draft(&tmp, &"あ".repeat(len), &[]).unwrap();
            browse_all(tmp.path()).unwrap().remove(0).snippet
        };

        assert_eq!(snippet_of(40), "あ".repeat(40));
        assert_eq!(snippet_of(41), format!("{}…", "あ".repeat(40)));
    }

    /// There is no notion of a match, so there is nothing to highlight either.
    #[test]
    fn a_browsed_hit_has_no_match_position() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(tmp.path(), "なんでもよい", &context(), Source::App).unwrap();
        draft(&tmp, "ノートも", &[]).unwrap();

        let hits = browse_all(tmp.path()).unwrap();

        assert_eq!(hits.len(), 2);
        assert!(hits.iter().all(|h| h.match_start.is_none()));
        assert!(hits.iter().all(|h| h.match_len.is_none()));
    }

    /// One unreadable note does not fail the whole scan (same policy as `search_all`).
    /// Its body comes empty, so the title and snippet are empty, but it stays in the count:
    /// what is counted is the files in the tree, and an empty body cannot filter them out.
    #[test]
    fn an_unreadable_note_does_not_fail_the_browse() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();
        draft(&tmp, "読めるノート", &[]).unwrap();
        let locked = draft(&tmp, "読めないノート", &[]).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();

        let hits = browse_all(tmp.path()).unwrap();

        assert_eq!(hits.len(), 2);
        assert!(hits.iter().any(|h| h.title == "読めるノート"));
    }

    /// The Browse screen counts from this list. Reusing the 100-hit cap of `search_all`
    /// would make the counts lie from the 101st record on.
    #[test]
    fn browsing_is_not_capped() {
        let tmp = TempDir::new().unwrap();
        let oldest = Day::new(2025, 1, 1).unwrap();
        for offset in 0..=MAX_HITS {
            let date = oldest.plus_days(i64::try_from(offset).unwrap()).unwrap();
            write_day(&tmp, date, &format!("記録 {offset}"));
        }

        let hits = browse_all(tmp.path()).unwrap();

        assert_eq!(hits.len(), MAX_HITS + 1);
        assert_eq!(hits[MAX_HITS].date, "2025-01-01");
    }
}
