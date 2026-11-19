//! Checks the layer rules of `core/src` (docs/architecture.md).
//!
//! - `utils` knows no outside party and no app rule: it names neither `services` nor `domain`.
//! - `services` only talk to the outside: they do not name `domain`.
//! - `domain` reaches the file system only through `services::files`.
//! - A module entry file holds only `mod` lines and re-exports.
//! - A rule file inside `domain` names no service.
//!
//! The check reads the source as text, so it is rough: only the production part of each
//! file (before its first test module) and only code lines, not comments. What it buys is
//! that every step of the move says it is done by taking its lines out of [`ALLOWED`].

// Failing is the test's job (the same disclaimer as `core/src/lib.rs`).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

/// Rule files inside `domain/` (paths under the crate root). They hold the rules alone,
/// so they are tested with plain values and never call a service.
const RULE_FILES: &[&str] = &[
    "src/domain/codex/version.rs",
    "src/domain/data.rs",
    "src/domain/device/context.rs",
    "src/domain/device/place.rs",
    "src/domain/glyphs/image.rs",
    "src/domain/note/file.rs",
    "src/domain/note/id.rs",
    "src/domain/note/kind.rs",
    "src/domain/note/revision.rs",
    "src/domain/note/row.rs",
    "src/domain/scrawl/day.rs",
    "src/domain/scrawl/entry.rs",
    "src/domain/sync/conflict_copy.rs",
    "src/domain/sync/diff.rs",
    "src/domain/sync/result.rs",
    "src/domain/sync/rounds.rs",
    "src/domain/sync/token.rs",
    "src/domain/tags/tag.rs",
    "src/domain/templates/file.rs",
    "src/domain/templates/today.rs",
    "src/domain/templates/variables.rs",
];

/// Violations the tree still has, each with the plan that removes it. A step that clears
/// one takes its line out; a line that no longer matches anything fails the check.
const ALLOWED: &[(&str, Rule, u32)] = &[
    ("src/domain/sync/run.rs", Rule::DomainUsesStdFs, 32),
    ("src/domain/sync/scan.rs", Rule::DomainUsesStdFs, 32),
    ("src/domain/sync/state.rs", Rule::DomainUsesStdFs, 32),
    ("src/utils/clock.rs", Rule::EntryHoldsOnlyModAndPubUse, 33),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Rule {
    UtilsImportsServices,
    UtilsImportsDomain,
    ServicesImportsDomain,
    DomainUsesStdFs,
    EntryHoldsOnlyModAndPubUse,
    ServicesInRuleFile,
}

impl fmt::Display for Rule {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::UtilsImportsServices => "utils-imports-services",
            Self::UtilsImportsDomain => "utils-imports-domain",
            Self::ServicesImportsDomain => "services-imports-domain",
            Self::DomainUsesStdFs => "domain-uses-std-fs",
            Self::EntryHoldsOnlyModAndPubUse => "entry-holds-only-mod-and-pub-use",
            Self::ServicesInRuleFile => "rule-file-imports-services",
        })
    }
}

#[derive(Debug)]
struct Violation {
    path: String,
    line: usize,
    rule: Rule,
}

impl fmt::Display for Violation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{} {}", self.path, self.line, self.rule)
    }
}

#[test]
fn the_core_tree_keeps_its_layer_rules() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    collect_rs_files(&root.join("src"), &mut files);

    let mut violations = Vec::new();
    for file in &files {
        let relative = file
            .strip_prefix(root)
            .expect("under the crate root")
            .to_string_lossy()
            .replace('\\', "/");
        let source = fs::read_to_string(file).expect("readable source");
        violations.extend(check_file(&relative, &source, is_entry_file(file)));
    }

    let unexpected: Vec<String> = violations
        .iter()
        .filter(|v| !is_allowed(&v.path, v.rule))
        .map(ToString::to_string)
        .collect();
    let stale: Vec<String> = ALLOWED
        .iter()
        .filter(|(path, rule, _)| {
            !violations
                .iter()
                .any(|v| v.path == *path && v.rule == *rule)
        })
        .map(|(path, rule, plan)| format!("{path} {rule} (plan {plan})"))
        .collect();

    assert!(
        unexpected.is_empty() && stale.is_empty(),
        "layer rules broken:\n  {}\nallowed but no longer broken (take them out of ALLOWED):\n  {}",
        unexpected.join("\n  "),
        stale.join("\n  "),
    );
}

fn is_allowed(path: &str, rule: Rule) -> bool {
    ALLOWED.iter().any(|(p, r, _)| *p == path && *r == rule)
}

fn collect_rs_files(dir: &Path, into: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).expect("readable directory") {
        let path = entry.expect("readable entry").path();
        if path.is_dir() {
            collect_rs_files(&path, into);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            into.push(path);
        }
    }
}

/// `lib.rs`, `mod.rs`, and an `X.rs` that has an `X/` directory beside it.
fn is_entry_file(path: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    name == "lib.rs" || name == "mod.rs" || path.with_extension("").is_dir()
}

fn check_file(path: &str, source: &str, entry: bool) -> Vec<Violation> {
    let lines = production_lines(source);
    let mut found = Vec::new();
    let mut push = |line: usize, rule: Rule| {
        found.push(Violation {
            path: path.to_string(),
            line,
            rule,
        });
    };

    for (number, line) in code_lines(&lines) {
        if path.starts_with("src/utils/") {
            if mentions(line, "crate::services") {
                push(number, Rule::UtilsImportsServices);
            }
            if mentions(line, "crate::domain") {
                push(number, Rule::UtilsImportsDomain);
            }
        }
        if path.starts_with("src/services/") && mentions(line, "crate::domain") {
            push(number, Rule::ServicesImportsDomain);
        }
        if path.starts_with("src/domain/") && mentions(line, "std::fs") {
            push(number, Rule::DomainUsesStdFs);
        }
        if RULE_FILES.contains(&path) && mentions(line, "crate::services") {
            push(number, Rule::ServicesInRuleFile);
        }
    }
    if entry {
        for number in entry_breaches(&lines) {
            push(number, Rule::EntryHoldsOnlyModAndPubUse);
        }
    }
    found
}

/// The lines before the first test module, numbered from 1.
///
/// The cut is a `#[cfg(...test...)]` attribute whose item is an inline `mod name {`, not
/// any `#[cfg(test)]`: an entry file declares a test-only submodule (`mod golden;`)
/// above its production code.
fn production_lines(source: &str) -> Vec<(usize, &str)> {
    let lines: Vec<&str> = source.lines().collect();
    let end = (0..lines.len())
        .find(|&i| {
            let line = lines[i].trim();
            line.starts_with("#[cfg(")
                && line.contains("test")
                && lines[i + 1..]
                    .iter()
                    .map(|l| l.trim())
                    .find(|l| !l.is_empty() && !l.starts_with("#["))
                    .is_some_and(|item| {
                        let item = item.strip_prefix("pub ").unwrap_or(item);
                        item.starts_with("mod ") && item.ends_with('{')
                    })
        })
        .unwrap_or(lines.len());
    lines[..end]
        .iter()
        .enumerate()
        .map(|(i, line)| (i + 1, *line))
        .collect()
}

/// The lines that are code, leaving out line and block comments.
fn code_lines<'a>(lines: &[(usize, &'a str)]) -> Vec<(usize, &'a str)> {
    let mut in_block = false;
    let mut code = Vec::new();
    for &(number, line) in lines {
        let trimmed = line.trim();
        if in_block {
            in_block = !trimmed.contains("*/");
            continue;
        }
        if trimmed.starts_with("/*") {
            in_block = !trimmed.contains("*/");
            continue;
        }
        if trimmed.starts_with("//") {
            continue;
        }
        code.push((number, line));
    }
    code
}

/// The lines of an entry file that are neither blank, a comment, an attribute, a `mod`
/// line nor a `pub use` / `pub(crate) use` (each of the last two may span lines).
fn entry_breaches(lines: &[(usize, &str)]) -> Vec<usize> {
    const OPENERS: &[&str] = &[
        "mod ",
        "pub mod ",
        "pub(crate) mod ",
        "pub use ",
        "pub(crate) use ",
    ];
    let mut breaches = Vec::new();
    let mut open_item = false;
    let mut open_attribute = 0_i32;
    for (number, line) in code_lines(lines) {
        let trimmed = line.trim();
        if open_item {
            open_item = !trimmed.ends_with(';');
            continue;
        }
        if open_attribute > 0 {
            open_attribute += bracket_balance(trimmed);
            continue;
        }
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with("#[") || trimmed.starts_with("#![") {
            open_attribute = bracket_balance(trimmed);
            continue;
        }
        if OPENERS.iter().any(|opener| trimmed.starts_with(opener)) {
            open_item = !trimmed.ends_with(';');
            continue;
        }
        breaches.push(number);
    }
    breaches
}

fn bracket_balance(line: &str) -> i32 {
    line.chars().fold(0, |depth, c| match c {
        '[' => depth + 1,
        ']' => depth - 1,
        _ => depth,
    })
}

/// Whether `line` names `path` as a whole path segment (`crate::sync` but not
/// `crate::sync_state`).
fn mentions(line: &str, path: &str) -> bool {
    line.match_indices(path).any(|(at, _)| {
        let before = line[..at].chars().next_back();
        let after = line[at + path.len()..].chars().next();
        !before.is_some_and(is_ident_char) && !after.is_some_and(is_ident_char)
    })
}

const fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

// The checker itself, on small sources: a rule that silently matches nothing would pass
// the tree for the wrong reason.

#[test]
fn an_entry_file_may_hold_mod_lines_and_multi_line_re_exports() {
    let source = "//! Doc.\n\
        #![cfg_attr(test, allow(\n    clippy::unwrap_used,\n))]\n\
        \n\
        mod a;\n\
        #[cfg(feature = \"x\")]\n\
        pub mod b;\n\
        pub use a::{\n    One,\n    Two,\n};\n\
        pub(crate) use b::Three;\n";

    assert!(check_file("src/x.rs", source, true).is_empty());
}

#[test]
fn an_entry_file_with_code_is_reported_at_the_code() {
    let source = "mod a;\nuse std::path::Path;\npub fn f() {}\n";

    let lines: Vec<usize> = check_file("src/x.rs", source, true)
        .iter()
        .map(|v| v.line)
        .collect();
    assert_eq!(lines, vec![2, 3]);
}

#[test]
fn a_test_module_is_not_checked_but_a_test_only_submodule_line_is_not_the_cut() {
    let source = "#[cfg(test)]\nmod golden;\npub fn now() {}\n\
        #[cfg(test)]\nmod tests {\n    fn helper() {}\n}\n";

    let lines: Vec<usize> = check_file("src/x.rs", source, true)
        .iter()
        .map(|v| v.line)
        .collect();
    assert_eq!(lines, vec![3]);
}

#[test]
fn a_service_naming_domain_is_reported_but_not_a_longer_name() {
    let source = "use crate::domain::sync::SyncResult;\nuse crate::domain_x;\n\
        // crate::domain in a comment\n";

    let rules: Vec<(usize, Rule)> = check_file("src/services/x.rs", source, false)
        .iter()
        .map(|v| (v.line, v.rule))
        .collect();
    assert_eq!(rules, vec![(1, Rule::ServicesImportsDomain)]);
}

#[test]
fn domain_code_naming_std_fs_is_reported() {
    let rules: Vec<Rule> = check_file("src/domain/x.rs", "use std::fs;\n", false)
        .iter()
        .map(|v| v.rule)
        .collect();
    assert_eq!(rules, vec![Rule::DomainUsesStdFs]);
}
