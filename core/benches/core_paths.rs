//! Measures the core paths that run on each UI action. The functions here are called from
//! Tauri commands, directly or (the scan) through the sync engine, so they are the perceived
//! latency as is.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    missing_debug_implementations
)]

mod fixture;

use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use std::hint::black_box;

use magical_merchant_core::search::{HitKind, SearchFilter};
use magical_merchant_core::sync::scan::scan_local_files;
use magical_merchant_core::{
    browse_all, find_backlinks, list_notes, list_scrawl_dates, read_scrawl, recent_records,
    search_all, search_records,
};

fn search(c: &mut Criterion) {
    let tmp = fixture::build();
    let base = tmp.path();

    let mut group = c.benchmark_group("search_all");
    group.throughput(Throughput::Elements(
        u64::try_from(fixture::DAYS).unwrap() * u64::try_from(fixture::ENTRIES_PER_DAY).unwrap(),
    ));
    for (label, needle) in [
        ("miss", fixture::MISS_NEEDLE),
        ("rare", fixture::RARE_NEEDLE),
        ("common", fixture::COMMON_NEEDLE),
    ] {
        group.bench_with_input(BenchmarkId::from_parameter(label), needle, |b, needle| {
            b.iter(|| search_all(black_box(base), black_box(needle), &[]).unwrap());
        });
    }
    group.finish();
}

/// Runs every time a note is opened. It has no index and scans the full text each time, as
/// `search_all` does, so both hit the same ceiling: measure them together.
fn backlinks(c: &mut Criterion) {
    let tmp = fixture::build();
    let base = tmp.path();
    let target = fixture::backlink_target();

    c.bench_function("find_backlinks", |b| {
        b.iter(|| find_backlinks(black_box(base), black_box(&target)).unwrap());
    });
}

/// What the search field reads the moment it opens (and Browse, and the tag suggestions):
/// every Scrawl day and every note, with no needle to stop early on. `search_records` with a
/// kind alone is the other no-needle path, taken when a kind chip is pressed in the field.
fn browsing(c: &mut Criterion) {
    let tmp = fixture::build();
    let base = tmp.path();

    c.bench_function("browse_all", |b| {
        b.iter(|| browse_all(black_box(base)).unwrap());
    });

    // The search field opens on `recent_records`. The scan is the same; what differs is the
    // payload the Tauri command serializes and the webview parses, so that is measured too,
    // and its size is printed once because criterion has no column for it.
    c.bench_function("recent_records/20", |b| {
        b.iter(|| recent_records(black_box(base), 20).unwrap());
    });
    let all = browse_all(base).unwrap();
    let recent = recent_records(base, 20).unwrap();
    eprintln!(
        "payload: browse_all {} bytes, recent_records/20 {} bytes",
        serde_json::to_string(&all).unwrap().len(),
        serde_json::to_string(&recent).unwrap().len()
    );
    c.bench_function("browse_all/to_json", |b| {
        b.iter(|| serde_json::to_string(black_box(&all)).unwrap());
    });
    c.bench_function("recent_records/20/to_json", |b| {
        b.iter(|| serde_json::to_string(black_box(&recent)).unwrap());
    });

    let notes_only = SearchFilter {
        kind: Some(HitKind::Note),
        ..SearchFilter::default()
    };
    c.bench_function("search_records/kind_note", |b| {
        b.iter(|| search_records(black_box(base), "", &[], black_box(&notes_only)).unwrap());
    });
}

fn listing(c: &mut Criterion) {
    let tmp = fixture::build();
    let base = tmp.path();

    c.bench_function("list_notes", |b| {
        b.iter(|| list_notes(black_box(base)).unwrap());
    });

    c.bench_function("list_scrawl_dates", |b| {
        b.iter(|| list_scrawl_dates(black_box(base)).unwrap());
    });

    // What the Scrawl tab reads right after start.
    let dates = fixture::recent_dates();
    c.bench_function("read_scrawl_recent_14", |b| {
        b.iter(|| {
            for date in &dates {
                black_box(read_scrawl(black_box(base), *date).unwrap());
            }
        });
    });
}

fn sync_scan(c: &mut Criterion) {
    let tmp = fixture::build();
    let base = tmp.path();

    c.bench_function("scan_local_files", |b| {
        b.iter(|| scan_local_files(black_box(base)).unwrap());
    });
}

criterion_group!(benches, search, backlinks, browsing, listing, sync_scan);
criterion_main!(benches);
