use magical_merchant_core::*;
use std::{fs, time::Instant};

#[test]
fn audit_measure_version_status_growth() {
    for count in [1, 20, 200] {
        let dir = tempfile::tempdir().unwrap();
        let body = "x".repeat(256 * 1024);
        let path = create_draft_codex(
            dir.path(),
            &body,
            &[],
            &DeviceContext::default(),
            Provenance::default(),
        )
        .unwrap();
        let filename = NoteFilename::parse(path.file_name().unwrap().to_str().unwrap()).unwrap();
        let versions = path.with_extension("");
        fs::create_dir_all(&versions).unwrap();
        let start = chrono::DateTime::parse_from_rfc3339("2026-09-20T00:00:00Z").unwrap();
        for i in 0..count {
            let time = start + chrono::Duration::seconds(i);
            let id = format!("{}-00000000.md", time.format("%Y%m%d_%H%M%S"));
            fs::write(
                versions.join(id),
                format!("---\ntime: {}\n---\n{body}", time.to_rfc3339()),
            )
            .unwrap();
        }
        let mut elapsed = Vec::new();
        for _ in 0..7 {
            let now = Instant::now();
            let status = note_version_status(dir.path(), &filename).unwrap();
            assert_eq!(status.count, count as usize);
            elapsed.push(now.elapsed().as_micros());
        }
        elapsed.sort_unstable();
        println!(
            "AUDIT version_status versions={count} body_bytes={} median_us={}",
            body.len(),
            elapsed[3]
        );
    }
}
