//! UI 操作ごとに走る core の経路を測る。ここに出てくる関数は Tauri コマンド
//! から直接呼ばれるので、そのまま体感レイテンシになる。
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    missing_debug_implementations
)]

mod fixture;

use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use std::hint::black_box;

use magical_merchant_core::sync::scan::scan_local_files;
use magical_merchant_core::{
    find_backlinks, list_notes, list_scrawl_dates, read_scrawl, search_all,
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

/// ノートを開くたびに走る。索引を持たず毎回全文を走査するので、`search_all` が
/// 全文検索になったときにどちらも同じ天井に当たる — 並べて測る。
fn backlinks(c: &mut Criterion) {
    let tmp = fixture::build();
    let base = tmp.path();
    let target = fixture::backlink_target();

    c.bench_function("find_backlinks", |b| {
        b.iter(|| find_backlinks(black_box(base), black_box(&target)).unwrap());
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

    // 起動直後に Scrawl タブが読む分。
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

criterion_group!(benches, search, backlinks, listing, sync_scan);
criterion_main!(benches);
