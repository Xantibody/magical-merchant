//! A line diff between two texts, in the unified format.

use similar::{Algorithm, TextDiff};

/// Histogram in 3.x is extremely slow on large input (seconds at 100,000 lines). Myers is
/// fast enough at note sizes, and has a linear-time path even for two unrelated texts.
#[must_use]
pub fn unified_diff(old: &str, new: &str, old_name: &str, new_name: &str) -> String {
    if old == new {
        return String::new();
    }
    TextDiff::configure()
        .algorithm(Algorithm::Myers)
        .diff_lines(old, new)
        .unified_diff()
        .context_radius(3)
        .header(old_name, new_name)
        .to_string()
}
