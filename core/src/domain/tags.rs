//! Tags: the `#tag` written in a record, and how many records carry each.

pub mod tag;
mod usage;

pub use usage::{TagUsage, count_tags};
