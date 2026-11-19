//! Note templates.
//!
//! A template itself is plain Markdown under `data/templates/*.md`, synced the same way
//! as a note. The only special thing is that `{{...}}` can be written in the body and the
//! tags; it becomes a value at the moment a note is created from here. Inside the template
//! file it stays a string to the end (`variables`).

mod draft;
mod edit;
mod file;
mod folder;
mod new_note;
mod today;
mod variables;

pub use draft::{
    discard_template_draft, list_template_drafts, read_template_draft, save_template_draft,
};
pub use edit::{
    TemplateDetail, delete_template, list_templates, read_template, rename_template, save_template,
};
pub use file::Summary as TemplateSummary;
pub use new_note::{CreatedNote, create_note_from_template};
pub use today::{TemplateToday, templates_today};
pub use variables::VarLocale;
