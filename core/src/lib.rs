mod error;
mod format;
mod note;
mod path;
mod project;
mod save;
pub mod shared;
pub mod sync;

pub use error::CoreError;
pub use format::{format_note_markdown, format_timeline_line};
pub use note::{
    NoteSummary, create_draft_note, delete_note, list_notes, read_note, read_note_by_filename,
    update_note,
};
pub use path::{
    active_tasks_dir, done_tasks_dir, note_file_path, project_dir, project_file_path, projects_dir,
    timeline_file_path,
};
pub use project::{
    ProjectActivitySummary, ProjectSummary, TaskSummary, complete_task, create_project,
    create_task, delete_task, get_project_activity_summary, list_active_tasks, list_done_tasks,
    list_projects, read_project, update_task,
};
pub use save::{list_timeline_dates, read_timeline, save_note, save_timeline_entry};
pub use shared::context::DeviceContext;
pub use shared::frontmatter;
pub use shared::validated::{Filename, NoteFilename, Slug};
