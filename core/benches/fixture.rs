//! Dataset generation for the benches. Files are written directly rather than through the
//! API because the save path depends on `Local::now()` and cannot spread the dates.

use std::fmt::Write as _;
use std::fs;
use std::path::Path;

use chrono::{Duration, NaiveDate};
use magical_merchant_core::NoteFilename;
use magical_merchant_core::frontmatter::{self, NoteFrontmatter};
use tempfile::TempDir;

/// One year of a heavy user. The numbers are fixed because changing them breaks before/after
/// comparison. To measure across counts and body lengths, temporarily rewrite only these two
/// (and `NOTE_BODY_LINES`) and measure again: the shape of the fixture itself does not change.
pub(crate) const DAYS: i64 = 365;
pub(crate) const ENTRIES_PER_DAY: usize = 20;
pub(crate) const NOTES: usize = 500;
/// Body lines per note. `search_all` reads the full text, while the list's preview is only
/// the first 100 characters, so the body must be well past that for the bench to measure a
/// full-text scan rather than a preview-sized one.
const NOTE_BODY_LINES: usize = 12;

/// A word that appears in only 1/`RARE_EVERY` of all entries.
pub(crate) const RARE_NEEDLE: &str = "ゼオライト";
/// A word that appears in every entry: `body` always appends it.
pub(crate) const COMMON_NEEDLE: &str = "メモ";
/// A word that appears nowhere. The worst case, which scans every record.
pub(crate) const MISS_NEEDLE: &str = "quetzalcoatlus";

const RARE_EVERY: usize = 97;

/// A linear congruential generator for reproducibility. Not a use that justifies adding
/// `rand` as a dev-dependency.
struct Lcg(u64);

impl Lcg {
    const fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1);
        self.0 >> 33
    }

    fn pick<'a>(&mut self, choices: &[&'a str]) -> &'a str {
        let index = usize::try_from(self.next()).expect("u64 fits usize on 64-bit");
        choices[index % choices.len()]
    }
}

const SUBJECTS: &[&str] = &[
    "同期処理",
    "エディタ",
    "検索",
    "Scrawl",
    "R2 バケット",
    "Milkdown",
    "Tauri コマンド",
    "フロントマター",
];

const PREDICATES: &[&str] = &[
    "のリトライ戦略を詰める",
    "が遅いので計測した",
    "のテストを書き直す",
    "でメモが消える件",
    "の設計メモ",
    "を lightweight に保つ",
];

fn body(rng: &mut Lcg, index: usize) -> String {
    let mut text = format!("{}{} のメモ", rng.pick(SUBJECTS), rng.pick(PREDICATES));
    if index.is_multiple_of(RARE_EVERY) {
        let _ = write!(text, " — {RARE_NEEDLE} を試す");
    }
    // Some are multi-line, matching real data
    if index.is_multiple_of(5) {
        text.push_str("\n続き: 明日あらためて確認する");
    }
    text
}

const CONTEXT_JSON: &str = r#"{"battery":72,"is_charging":false,"network_type":"WiFi","os":"macos","os_version":"15.5","arch":"aarch64"}"#;

const fn start_date() -> NaiveDate {
    NaiveDate::from_ymd_opt(2025, 1, 1).expect("literal date")
}

fn write_scrawl(base: &Path, rng: &mut Lcg) {
    let dir = base.join("data").join("scrawl");
    fs::create_dir_all(&dir).expect("create scrawl dir");

    for day in 0..DAYS {
        let date = start_date() + Duration::days(day);
        let mut file = String::new();
        for entry in 0..ENTRIES_PER_DAY {
            let index = usize::try_from(day).expect("day fits") * ENTRIES_PER_DAY + entry;
            let hour = 6 + entry % 16;
            let minute = (entry * 7) % 60;
            let text = body(rng, index);
            let _ = writeln!(file, "- [{hour:02}:{minute:02}:00] {text} {CONTEXT_JSON}");
        }
        fs::write(dir.join(format!("{}.md", date.format("%Y-%m-%d"))), file)
            .expect("write scrawl day");
    }
}

fn write_notes(base: &Path, rng: &mut Lcg) {
    let dir = base.join("data").join("notes");
    fs::create_dir_all(&dir).expect("create notes dir");

    for index in 0..NOTES {
        let date = start_date() + Duration::days(i64::try_from(index).expect("index fits") % DAYS);
        let time = date
            .and_hms_opt(9, 0, 0)
            .expect("literal time")
            .and_local_timezone(chrono::FixedOffset::east_opt(9 * 3600).expect("literal offset"))
            .single()
            .expect("unambiguous");

        let fm = NoteFrontmatter {
            tags: vec!["memo".to_string(), rng.pick(SUBJECTS).to_string()],
            ..NoteFrontmatter::new(time)
        };
        // preview reads only the first 100 characters. The body is made well longer than that.
        let mut text = String::new();
        for line in 0..NOTE_BODY_LINES {
            text.push_str(&body(rng, index * NOTE_BODY_LINES + line));
            text.push('\n');
        }
        let content = frontmatter::render(&fm, &text).expect("render note");
        fs::write(dir.join(note_filename(index)), content).expect("write note");
    }
}

/// A note's filename. Callers use it too, to point at the backlink target.
fn note_filename(index: usize) -> String {
    format!("note-{index:04}.md")
}

/// Built once and shared by every bench. The `TempDir` lives only as long as the return value.
#[must_use]
pub(crate) fn build() -> TempDir {
    let tmp = TempDir::new().expect("create tempdir");
    let mut rng = Lcg(0x2026_0804);
    write_scrawl(tmp.path(), &mut rng);
    write_notes(tmp.path(), &mut rng);
    tmp
}

/// The note whose backlinks are looked up. The fixture contains not one `[[...]]`, so this
/// is the worst case: "read every note and every day through and hit nothing". More hits
/// would only add excerpt building; the amount scanned does not change.
#[must_use]
pub(crate) fn backlink_target() -> NoteFilename {
    NoteFilename::parse(&note_filename(0)).expect("fixture filename is valid")
}

/// The dates the UI reads on first display (the newest 14 days).
#[must_use]
pub(crate) fn recent_dates() -> Vec<NaiveDate> {
    (0..14)
        .map(|back| start_date() + Duration::days(DAYS - 1 - back))
        .collect()
}
