use super::*;
use std::{collections::HashMap, fs};

#[test]
fn audit_download_must_preserve_an_edit_after_scan() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    fs::create_dir_all(data.join("notes")).unwrap();
    let path = data.join("notes/a.md");
    fs::write(&path, "old").unwrap();
    let scanned = scan::scan_local_files(dir.path()).unwrap();
    fs::write(&path, "saved while network request was pending").unwrap();
    let response = BulkResponse {
        downloads: vec![DownloadedFile {
            key: "notes/a.md".into(),
            content_base64: B64.encode("remote"),
        }],
        conflict_downloads: vec![],
        new_state: ServerSyncState {
            files: HashMap::new(),
            last_sync: None,
            etag: None,
        },
    };
    let mut result = SyncResult::default();
    apply_response(
        &response,
        &[SyncAction::DownloadModified {
            key: "notes/a.md".into(),
        }],
        &scanned,
        dir.path(),
        &mut result,
    );
    assert_eq!(
        fs::read_to_string(path).unwrap(),
        "saved while network request was pending"
    );
}

#[test]
fn audit_upload_hash_must_describe_the_uploaded_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    fs::create_dir_all(data.join("notes")).unwrap();
    let path = data.join("notes/a.md");
    fs::write(&path, "old").unwrap();
    let scanned = scan::scan_local_files(dir.path()).unwrap();
    fs::write(path, "edited after scan").unwrap();
    let request = build_bulk_request(
        &[SyncAction::UploadNew {
            key: "notes/a.md".into(),
        }],
        &scanned,
        &data,
        None,
        &mut SyncResult::default(),
    )
    .unwrap();
    let upload = &request.uploads[0];
    let sent = B64.decode(&upload.content_base64).unwrap();
    assert_eq!(upload.hash, scan::compute_hash(&sent));
}

#[test]
fn audit_conflict_download_must_not_replace_an_existing_backup() {
    let dir = tempfile::tempdir().unwrap();
    let response = |body: &str| BulkResponse {
        downloads: vec![],
        conflict_downloads: vec![DownloadedFile {
            key: "notes/a.sync-conflict-20260920-120000.md".into(),
            content_base64: B64.encode(body),
        }],
        new_state: ServerSyncState {
            files: HashMap::new(),
            last_sync: None,
            etag: None,
        },
    };
    for body in ["first lost edit", "second lost edit"] {
        apply_response(
            &response(body),
            &[],
            &[],
            dir.path(),
            &mut SyncResult::default(),
        );
    }
    let entries: Vec<_> = fs::read_dir(dir.path().join("conflicts/notes/a"))
        .unwrap()
        .collect();
    assert_eq!(
        entries.len(),
        2,
        "both losing edits need a recoverable copy"
    );
}
