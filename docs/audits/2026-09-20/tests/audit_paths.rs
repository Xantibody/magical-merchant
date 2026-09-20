use magical_merchant_core::sync::scan::scan_local_files;
use std::{fs, os::unix::fs::symlink};

#[test]
fn audit_scan_must_not_follow_a_link_outside_data() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("data")).unwrap();
    fs::create_dir_all(dir.path().join("private")).unwrap();
    fs::write(
        dir.path().join("private/not-a-note.txt"),
        "synthetic private content",
    )
    .unwrap();
    symlink(dir.path().join("private"), dir.path().join("data/link")).unwrap();
    assert!(
        scan_local_files(dir.path()).unwrap().is_empty(),
        "outside content must not be uploaded"
    );
}
