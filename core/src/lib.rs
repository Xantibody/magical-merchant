mod error;
mod format;
mod path;
mod save;

pub use error::CoreError;
pub use format::{format_note_markdown, format_timeline_line, DeviceContext};
pub use path::{note_file_path, timeline_file_path};
pub use save::{save_note, save_timeline_entry};
