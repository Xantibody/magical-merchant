use magical_merchant_core::{utils::frontmatter::Provenance, *};
use std::{
    sync::{Arc, Barrier},
    thread,
};

#[test]
fn audit_concurrent_captures_must_all_survive() {
    let dir = tempfile::tempdir().unwrap();
    let n = 24;
    let gate = Arc::new(Barrier::new(n));
    thread::scope(|scope| {
        for i in 0..n {
            let gate = gate.clone();
            let base = dir.path();
            scope.spawn(move || {
                gate.wait();
                save_scrawl_entry(
                    base,
                    &format!("capture {i}"),
                    &DeviceContext::default(),
                    Source::App,
                )
                .unwrap();
            });
        }
    });
    let count = read_scrawl(dir.path(), chrono::Local::now().date_naive())
        .unwrap()
        .len();
    assert_eq!(count, n, "every call returned success");
}

#[test]
fn audit_only_one_writer_can_commit_the_same_revision() {
    let dir = tempfile::tempdir().unwrap();
    let original = "original".repeat(200000);
    let path = create_draft_note(
        dir.path(),
        &original,
        &[],
        &DeviceContext::default(),
        Provenance::default(),
    )
    .unwrap();
    let rev = Revision::of(&read_note(&path).unwrap());
    let n = 12;
    let gate = Arc::new(Barrier::new(n));
    let successes = thread::scope(|scope| {
        let handles: Vec<_> = (0..n)
            .map(|i| {
                let gate = gate.clone();
                let path = &path;
                let rev = &rev;
                scope.spawn(move || {
                    gate.wait();
                    update_note(
                        path,
                        &format!("writer {i}"),
                        &DeviceContext::default(),
                        Some(rev),
                    )
                    .is_ok()
                })
            })
            .collect();
        handles
            .into_iter()
            .filter(|h| h.thread().id() != thread::current().id())
            .map(|h| usize::from(h.join().unwrap()))
            .sum::<usize>()
    });
    assert_eq!(successes, 1, "stale writers must be refused");
}
