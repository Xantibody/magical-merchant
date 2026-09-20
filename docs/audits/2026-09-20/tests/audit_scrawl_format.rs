use magical_merchant_core::*;

#[test]
fn audit_a_multiline_checklist_must_remain_one_capture() {
    let dir = tempfile::tempdir().unwrap();
    let text = "Shopping\n- [ ] Milk\n- [x] Bread";
    save_scrawl_entry(dir.path(), text, &DeviceContext::default(), Source::App).unwrap();
    let entries = read_scrawl(dir.path(), chrono::Local::now().date_naive()).unwrap();
    assert_eq!(
        entries.len(),
        1,
        "one captured record must not become three records"
    );
    assert_eq!(parse_scrawl_entry(&entries[0]).text, text);
}
