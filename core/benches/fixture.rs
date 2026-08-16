//! ベンチ用のデータセット生成。API を通さず直接ファイルを書くのは、
//! `Local::now()` に依存する保存経路だと日付分布を作り分けられないため。

use std::fmt::Write as _;
use std::fs;
use std::path::Path;

use chrono::{Duration, NaiveDate};
use magical_merchant_core::frontmatter::{self, NoteFrontmatter};
use tempfile::TempDir;

/// ヘビーユーザーの 1 年分。数値を変えると before/after が比較できなくなるので固定する。
pub(crate) const DAYS: i64 = 365;
pub(crate) const ENTRIES_PER_DAY: usize = 20;
pub(crate) const NOTES: usize = 500;

/// 全エントリのうち 1/`RARE_EVERY` だけに現れる語。
pub(crate) const RARE_NEEDLE: &str = "ゼオライト";
/// ほぼ全エントリに現れる語。
pub(crate) const COMMON_NEEDLE: &str = "メモ";
/// どこにも現れない語。全件を走査させる最悪ケース。
pub(crate) const MISS_NEEDLE: &str = "quetzalcoatlus";

const RARE_EVERY: usize = 97;

/// 再現性のための線形合同法。`rand` を dev-dependency に足すほどの用途ではない。
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
    "タイムライン",
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
    // 実データに合わせて一部は複数行になる
    if index.is_multiple_of(5) {
        text.push_str("\n続き: 明日あらためて確認する");
    }
    text
}

const CONTEXT_JSON: &str = r#"{"battery":72,"is_charging":false,"network_type":"WiFi","os":"macos","os_version":"15.5","arch":"aarch64"}"#;

const fn start_date() -> NaiveDate {
    NaiveDate::from_ymd_opt(2025, 1, 1).expect("literal date")
}

fn write_timeline(base: &Path, rng: &mut Lcg) {
    let dir = base.join("data").join("timeline");
    fs::create_dir_all(&dir).expect("create timeline dir");

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
            .expect("write timeline day");
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
            time,
            tags: vec!["memo".to_string(), rng.pick(SUBJECTS).to_string()],
            context: None,
            view: None,
            origin: None,
        };
        // preview は先頭 100 文字しか読まれない。本文はそれより十分長くする。
        let mut text = String::new();
        for line in 0..12 {
            text.push_str(&body(rng, index * 12 + line));
            text.push('\n');
        }
        let content = frontmatter::render(&fm, &text).expect("render note");
        fs::write(dir.join(format!("note-{index:04}.md")), content).expect("write note");
    }
}

/// 一度だけ生成して全ベンチで共有する。`TempDir` は返り値が生きている間だけ有効。
#[must_use]
pub(crate) fn build() -> TempDir {
    let tmp = TempDir::new().expect("create tempdir");
    let mut rng = Lcg(0x2026_0804);
    write_timeline(tmp.path(), &mut rng);
    write_notes(tmp.path(), &mut rng);
    tmp
}

/// UI が初期表示で読む日付（新しい順に 14 日）。
#[must_use]
pub(crate) fn recent_dates() -> Vec<NaiveDate> {
    (0..14)
        .map(|back| start_date() + Duration::days(DAYS - 1 - back))
        .collect()
}
