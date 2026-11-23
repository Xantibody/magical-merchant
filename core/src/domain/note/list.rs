//! The list of every Note and Codex, and the one read of every note that search, the tag
//! count and backlinks share.

use std::path::Path;

use crate::domain::codex::version::version_mark;
use crate::domain::note::id::newest_first;
use crate::domain::note::{NoteKind, NoteSummary};
use crate::services::files::{Entry, list_md_files, read_text};
use crate::utils::error::CoreError;
use crate::utils::frontmatter;

pub fn list_notes(base_dir: &Path) -> Result<Vec<NoteSummary>, CoreError> {
    let mut summaries = Vec::new();
    scan(base_dir, |summary, _| summaries.push(summary))?;
    Ok(summaries)
}

/// Read every note once and hand `visit` the summary and the body with the
/// frontmatter stripped. If a path that looks at every body (search, backlinks)
/// re-reads each note after `list_notes`, that is two open(2) calls per note. On macOS
/// open takes about 60% of the whole path, so the content read to build the
/// summary is passed on as is.
///
/// The body is lent one note at a time; all bodies are never held at once.
/// Returning summary and body pairs in a Vec makes heap usage the sum of all
/// bodies in a large store.
///
/// A note that cannot be read yields an empty summary and an empty body, as in
/// `list_notes`.
///
/// Both directories are merged into one list, sorted by filename (creation
/// time), newest first. Filtering per surface is done by the caller via `kind`.
pub(crate) fn scan<F>(base_dir: &Path, mut visit: F) -> Result<(), CoreError>
where
    F: FnMut(NoteSummary, &str),
{
    let mut entries: Vec<(NoteKind, Entry)> = Vec::new();
    for kind in [NoteKind::Note, NoteKind::Codex] {
        for entry in list_md_files(&kind.dir(base_dir))? {
            entries.push((kind, entry));
        }
    }
    newest_first(&mut entries, |(_, e)| e.file_name());

    for (kind, entry) in entries {
        let path = entry.path();
        let filename = entry.file_name().to_string_lossy().to_string();
        let content = read_text(&path).unwrap_or_default();
        let body = frontmatter::strip(&content);
        // Versions live next to the note, under the name minus `.md` (`versions_dir`;
        // the scan has no `NoteFilename` to ask it with). Only their names are listed,
        // version bodies are not read
        let versions = path.with_extension("");
        let mut summary = NoteSummary::from_file(kind, path, filename, &content);
        if kind == NoteKind::Codex {
            let names: Vec<_> = list_md_files(&versions)?
                .iter()
                .map(Entry::file_name)
                .collect();
            let (count, dirty) = version_mark(&names, body);
            summary.version_count = Some(count);
            summary.dirty = Some(dirty);
        }
        visit(summary, body);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::codex::commit_note_version;
    use crate::domain::device::Context;
    use crate::domain::note::{Provenance, create_draft, update_note};
    use std::fs;
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn mock_context() -> Context {
        Context {
            battery: Some(50),
            is_charging: Some(false),
            ..Context::default()
        }
    }

    /// A plain new note that declares nothing, and where it was written. Every test except
    /// those about creation itself goes through this, so adding a provenance kind does not
    /// rewrite every test.
    fn draft(tmp: &TempDir, body: &str, tags: &[String]) -> Result<PathBuf, CoreError> {
        let filename = create_draft(
            tmp.path(),
            NoteKind::Note,
            body,
            tags,
            &mock_context(),
            Provenance::default(),
        )?;
        Ok(NoteKind::Note.dir(tmp.path()).join(filename.as_str()))
    }

    #[test]
    fn test_list_notes_empty() {
        let tmp = TempDir::new().unwrap();
        let notes = list_notes(tmp.path()).unwrap();
        assert!(notes.is_empty());
    }

    #[test]
    fn test_list_notes_returns_summaries() {
        let tmp = TempDir::new().unwrap();
        let tags = vec!["rust".to_string(), "test".to_string()];
        draft(&tmp, "# Hello\nBody text here", &tags).unwrap();

        let notes = list_notes(tmp.path()).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].tags, vec!["rust", "test"]);
        assert!(notes[0].time.is_some());
        assert!(notes[0].preview.contains("Hello"));
    }

    /// A file whose bytes are not text still takes its row in the list: it is read as
    /// empty, so it has no time and an empty preview, rather than hiding the rest.
    #[test]
    fn a_note_that_is_not_text_lists_with_an_empty_summary() {
        let tmp = TempDir::new().unwrap();
        let notes_dir = tmp.path().join("data/notes");
        fs::create_dir_all(&notes_dir).unwrap();
        fs::write(notes_dir.join("20260101_120000.md"), b"\xff\xfe body").unwrap();

        let listed = list_notes(tmp.path()).unwrap();

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].filename, "20260101_120000.md");
        assert_eq!(listed[0].time, None);
        assert_eq!(listed[0].preview, "");
    }

    /// Search and backlinks read every note's body. Calling `read_note` one by one after
    /// the list would mean two open(2) calls each, so the summary and body are passed together.
    #[test]
    fn scan_visits_each_summary_with_its_body_without_frontmatter() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "# Title\nbody #memo", &[]).unwrap();

        let mut visited = Vec::new();
        scan(tmp.path(), |summary, body| {
            visited.push((summary, body.to_string()));
        })
        .unwrap();

        assert_eq!(visited.len(), 1);
        let (summary, body) = &visited[0];
        assert_eq!(summary.path, path);
        assert_eq!(summary.tags, vec!["memo".to_string()]);
        assert_eq!(body, "# Title\nbody #memo");
    }

    /// The version count and "has it moved" shown on a list row. Version bodies are not
    /// read; only the hash in the filename is compared.
    #[test]
    fn the_list_carries_the_version_count_and_whether_the_draft_moved() {
        let tmp = TempDir::new().unwrap();
        let filename = create_draft(
            tmp.path(),
            NoteKind::Codex,
            "one",
            &[],
            &Context::default(),
            Provenance::default(),
        )
        .unwrap();
        let row = |base: &Path| {
            list_notes(base)
                .unwrap()
                .into_iter()
                .find(|s| s.filename == filename.as_str())
                .unwrap()
        };

        let none = row(tmp.path());
        assert_eq!(none.version_count, Some(0));
        assert_eq!(none.dirty, Some(false));

        commit_note_version(tmp.path(), &filename, None).unwrap();
        let clean = row(tmp.path());
        assert_eq!(clean.version_count, Some(1));
        assert_eq!(clean.dirty, Some(false));

        update_note(tmp.path(), &filename, "two", &Context::default(), None).unwrap();
        let moved = row(tmp.path());
        assert_eq!(moved.version_count, Some(1));
        assert_eq!(moved.dirty, Some(true));
    }

    /// A plain note's row has no version fields at all.
    #[test]
    fn a_plain_note_row_has_no_version_fields() {
        let tmp = TempDir::new().unwrap();
        create_draft(
            tmp.path(),
            NoteKind::Note,
            "plain",
            &[],
            &Context::default(),
            Provenance::default(),
        )
        .unwrap();

        let rows = list_notes(tmp.path()).unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].version_count, None);
        assert_eq!(rows[0].dirty, None);
    }
}
