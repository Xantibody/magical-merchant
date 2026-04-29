mod error;
mod infra;
mod note;
mod project;
pub mod shared;
pub mod sync;
mod timeline;

pub use error::CoreError;
pub use infra::markdown::{format_note_markdown, format_timeline_line};
pub use infra::paths::{
    active_tasks_dir, done_tasks_dir, note_file_path, project_dir, project_file_path, projects_dir,
    timeline_file_path,
};
pub use note::{
    NoteSummary, create_draft_note, delete_note, list_notes, read_note, read_note_by_filename,
    update_note,
};
pub use project::{
    ProjectActivitySummary, ProjectSummary, TaskSummary, complete_task, create_project,
    create_task, delete_task, get_project_activity_summary, list_active_tasks, list_done_tasks,
    list_projects, read_project, update_task,
};
pub use shared::context::DeviceContext;
pub use shared::frontmatter;
pub use shared::validated::{Filename, NoteFilename, Slug};
pub use timeline::{list_timeline_dates, read_timeline, save_timeline_entry};
