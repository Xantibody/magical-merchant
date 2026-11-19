//! This app's rules and the operations that apply them, shared by the app, the CLI, MCP
//! and the widget. Only operation files call `services`; rule files take plain values.

pub mod codex;
pub mod data;
pub mod device;
pub mod glyphs;
pub mod note;
pub mod scrawl;
pub mod search;
pub mod tags;
pub mod templates;
