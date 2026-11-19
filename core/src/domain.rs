//! This app's rules and the operations that apply them, shared by the app, the CLI, MCP
//! and the widget. Only operation files call `services`; rule files take plain values.

pub mod device;
pub mod glyphs;
pub mod scrawl;
pub mod templates;
