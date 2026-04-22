mod error;
mod format;
pub mod frontmatter;
mod note;
mod path;
mod project;
mod save;
pub mod sync;
mod validated;

pub use error::CoreError;
pub use format::{format_note_markdown, format_timeline_line, DeviceContext};
pub use note::{
    create_draft_note, delete_note, list_notes, read_note, read_note_by_filename, update_note,
    NoteSummary,
};
pub use path::{
    active_tasks_dir, done_tasks_dir, note_file_path, project_dir, project_file_path, projects_dir,
    timeline_file_path,
};
pub use project::{
    complete_task, create_project, create_task, delete_task, get_project_activity_summary,
    list_active_tasks, list_done_tasks, list_projects, read_project, update_task,
    ProjectActivitySummary, ProjectSummary, TaskSummary,
};
pub use save::{list_timeline_dates, read_timeline, save_note, save_timeline_entry};
pub use validated::{Filename, NoteFilename, Slug};
