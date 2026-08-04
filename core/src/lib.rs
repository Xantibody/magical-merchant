// A panicking assertion is the point of a test; only production code has to
// prove it handles the error case.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

mod note;
mod project;
pub mod sync;
mod timeline;
pub mod utils;

mod error;
pub mod search;

pub use error::CoreError;
pub use note::error::NoteError;
pub use note::{
    NoteSummary, create_draft_note, delete_note, list_notes, read_note, read_note_by_filename,
    update_note,
};
pub use project::error::ProjectError;
pub use project::{
    ProjectActivitySummary, ProjectSummary, TaskSummary, complete_task, create_project,
    create_task, delete_task, get_project_activity_summary, list_active_tasks, list_done_tasks,
    list_projects, read_project, update_task,
};
pub use search::{HitKind, SearchHit, search_all};
pub use timeline::error::TimelineError;
pub use timeline::{
    delete_timeline_entry, list_timeline_dates, read_timeline, save_timeline_entry,
    update_timeline_entry,
};
pub use utils::device::Context as DeviceContext;
pub use utils::frontmatter;
pub use utils::validated::{Filename, NoteFilename, Slug};
