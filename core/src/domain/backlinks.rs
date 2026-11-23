//! The records that point here: every Scrawl entry and note that links a note by `[[ID]]`.

use std::path::Path;

use crate::domain::note::{NoteFilename, list};
use crate::domain::search::{
    MAX_HITS, SNIPPET_CONTEXT, SearchFilter, SearchHit, first_line, scrawl_hits,
};
use crate::utils::error::CoreError;
use crate::utils::text::{lowercase, snippet};

/// Collect the records (notes, Scrawl) that mention `target` with `[[ID]]`.
///
/// There is no index; it is derived by a scan each time it is opened. Notes are read in
/// full, not the list's preview (first 100 characters): a link can be written anywhere
/// in the body.
pub fn find_backlinks(base_dir: &Path, target: &NoteFilename) -> Result<Vec<SearchHit>, CoreError> {
    let stem = target.as_str().trim_end_matches(".md");
    // The closing brackets are not included. `[[ID]]` and `[[ID|display text]]` are the
    // same single link, and a backlink must not vanish over the way it is written
    let needle = format!("[[{stem}");

    let mut hits = scrawl_hits(
        base_dir,
        &needle,
        &[],
        &SearchFilter::default(),
        Some(MAX_HITS),
    )?;

    // An unreadable note comes with an empty body and just drops out of the backlinks.
    // Better than showing a list that cannot be opened
    list::scan(base_dir, |note, body| {
        if note.filename == target.as_str() || !body.contains(&needle) {
            return;
        }
        let lowered = lowercase(body);
        let excerpt = snippet(body, &lowered, &needle, SNIPPET_CONTEXT);
        hits.push(SearchHit {
            kind: note.kind.into(),
            title: first_line(&note.preview).to_string(),
            snippet: excerpt.text,
            date: note.time.map(|t| t.day().ymd()).unwrap_or_default(),
            filename: Some(note.filename),
            index: None,
            tags: note.tags,
            match_start: excerpt.match_start,
            match_len: excerpt.match_len,
        });
    })?;

    for hit in &mut hits {
        extend_match_to_link_end(hit);
    }
    hits.sort_by(|a, b| b.date.cmp(&a.date));
    hits.truncate(MAX_HITS);
    Ok(hits)
}

/// Extend the excerpt's highlight to the end of the link's stored form.
///
/// The needle used for matching ends at `[[ID`, so as it is `|display text]]` would stay
/// in the body-text color and one could not tell where the link ends.
fn extend_match_to_link_end(hit: &mut SearchHit) {
    let (Some(start), Some(len)) = (hit.match_start, hit.match_len) else {
        return;
    };
    let chars: Vec<char> = hit.snippet.chars().collect();
    let mut at = start + len;
    while at + 1 < chars.len() {
        // Do not extend if the excerpt is cut off midway or another link starts
        if chars[at] == '\n' || chars[at] == '[' {
            return;
        }
        if chars[at] == ']' && chars[at + 1] == ']' {
            hit.match_len = Some(at + 2 - start);
            return;
        }
        at += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::device::{Context, Source};
    use crate::domain::note::{NoteKind, Provenance};
    use crate::domain::search::HitKind;
    use crate::{create_draft, save_scrawl_entry};
    use tempfile::TempDir;

    fn context() -> Context {
        Context::default()
    }

    /// A plain note to link or be linked, and where it was written. Provenance is not read,
    /// so none is declared.
    fn draft(tmp: &TempDir, body: &str, tags: &[String]) -> Result<std::path::PathBuf, CoreError> {
        let filename = create_draft(
            tmp.path(),
            NoteKind::Note,
            body,
            tags,
            &context(),
            Provenance::default(),
        )?;
        Ok(NoteKind::Note.dir(tmp.path()).join(filename.as_str()))
    }

    fn filename_of(path: &Path) -> NoteFilename {
        NoteFilename::parse(path.file_name().unwrap().to_str().unwrap()).unwrap()
    }

    fn stem_of(path: &Path) -> String {
        path.file_stem().unwrap().to_str().unwrap().to_string()
    }

    /// A hit whose excerpt is `snippet`, matched from its first `[[` over `[[ID`.
    fn link_hit(snippet: &str) -> SearchHit {
        let start = snippet
            .find("[[")
            .map(|byte| snippet[..byte].chars().count());
        SearchHit {
            kind: HitKind::Note,
            title: String::new(),
            snippet: snippet.to_string(),
            date: String::new(),
            filename: None,
            index: None,
            tags: Vec::new(),
            match_start: start,
            match_len: start.map(|_| "[[ID".chars().count()),
        }
    }

    /// What the highlight covers after the extension.
    fn extended(snippet: &str) -> String {
        let mut hit = link_hit(snippet);
        extend_match_to_link_end(&mut hit);
        hit.snippet
            .chars()
            .skip(hit.match_start.unwrap())
            .take(hit.match_len.unwrap())
            .collect()
    }

    #[test]
    fn the_highlight_reaches_the_end_of_a_link_with_display_text() {
        assert_eq!(extended("前に [[ID|前の話]] を見る"), "[[ID|前の話]]");
        assert_eq!(extended("[[ID]]"), "[[ID]]");
    }

    #[test]
    fn the_highlight_stops_before_a_newline() {
        assert_eq!(extended("[[ID|前の\n話]]"), "[[ID");
    }

    /// Another link starting before this one closes is not this link's text.
    #[test]
    fn the_highlight_stops_before_the_next_link() {
        assert_eq!(extended("[[ID|前の [[OTHER]]"), "[[ID");
    }

    /// The excerpt was cut before the link closed, so where it ends is not shown.
    #[test]
    fn a_link_cut_off_by_the_excerpt_is_not_extended() {
        assert_eq!(extended("[[ID|前の話…"), "[[ID");
    }

    #[test]
    fn a_hit_without_a_match_is_left_alone() {
        let mut hit = link_hit("リンクのない抜粋");
        extend_match_to_link_end(&mut hit);

        assert_eq!((hit.match_start, hit.match_len), (None, None));
    }

    #[test]
    fn a_scrawl_entry_that_links_a_note_is_a_backlink() {
        let tmp = TempDir::new().unwrap();
        let target = draft(&tmp, "指される側", &[]).unwrap();
        let link = format!("これ参照 [[{}]]", stem_of(&target));
        save_scrawl_entry(tmp.path(), &link, &context(), Source::App).unwrap();

        let hits = find_backlinks(tmp.path(), &filename_of(&target)).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, HitKind::Scrawl);
        assert!(hits[0].snippet.contains("これ参照"));
    }

    /// The list's preview is only the first 100 characters. A link can be written anywhere
    /// in the body, so without reading the whole text a deep link is missed.
    #[test]
    fn a_link_deep_in_a_long_note_is_still_found() {
        let tmp = TempDir::new().unwrap();
        let target = draft(&tmp, "指される側", &[]).unwrap();
        let body = format!("{}\n[[{}]]", "あ".repeat(300), stem_of(&target));
        draft(&tmp, &body, &[]).unwrap();

        let hits = find_backlinks(tmp.path(), &filename_of(&target)).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, HitKind::Note);
    }

    /// A note that links to itself in its own body is not "a record that links to it".
    #[test]
    fn a_note_is_not_its_own_backlink() {
        let tmp = TempDir::new().unwrap();
        let target = draft(&tmp, "後で本文に自分を書く", &[]).unwrap();
        let stem = stem_of(&target);
        crate::update_note(
            tmp.path(),
            &filename_of(&target),
            &format!("自分 [[{stem}]]"),
            &context(),
            None,
        )
        .unwrap();

        assert!(
            find_backlinks(tmp.path(), &filename_of(&target))
                .unwrap()
                .is_empty()
        );
    }

    /// A link with display text is the same single link. If a backlink vanished over the
    /// way it is written, only the references embedded naturally in prose would go unseen.
    #[test]
    fn a_link_with_display_text_is_a_backlink() {
        let tmp = TempDir::new().unwrap();
        let target = draft(&tmp, "指される側", &[]).unwrap();
        let body = format!("詳しくは [[{}|前の話]] を見る", stem_of(&target));
        draft(&tmp, &body, &[]).unwrap();

        let hits = find_backlinks(tmp.path(), &filename_of(&target)).unwrap();

        assert_eq!(hits.len(), 1);
        // The highlight runs to the end of the stored form. If `|前の話]]` stayed in the
        // body-text color, one could not tell where the link ends
        let start = hits[0].match_start.unwrap();
        let len = hits[0].match_len.unwrap();
        let matched: String = hits[0].snippet.chars().skip(start).take(len).collect();
        assert!(matched.ends_with("|前の話]]"), "matched: {matched}");
    }

    #[test]
    fn no_links_means_no_backlinks() {
        let tmp = TempDir::new().unwrap();
        let target = draft(&tmp, "誰も指していない", &[]).unwrap();
        draft(&tmp, "無関係なノート", &[]).unwrap();
        save_scrawl_entry(tmp.path(), "無関係なエントリ", &context(), Source::App).unwrap();

        assert!(
            find_backlinks(tmp.path(), &filename_of(&target))
                .unwrap()
                .is_empty()
        );
    }
}
