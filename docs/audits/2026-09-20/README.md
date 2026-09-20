# Repository audit — 2026-09-20

Audited commit: `adb7d56bc29a33f68dfe865d19736712a02037ab`.

The existing verification suite passes, but additional adversarial tests expose data-loss races and save-state failures. **19 reproduction tests fail across 18 findings** (two code-rendering tests share one finding). One separate performance measurement passes. These counts describe tested scenarios, not a claim that every defect in the repository has been found.

Production source was not patched. Reproductions ran against a `git archive` snapshot in a temporary directory, with synthetic data and local Workers/Chromium runtimes. This directory contains the findings and an opt-in reproduction harness. Its probes live outside the application's normal test suites because they assert properties that fail on the audited revision.

## Verification and scope

| Check                      | Result                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `just verify`              | Passed after allowing the Nix cache and local test runtimes outside the sandbox                                       |
| Rust                       | 499 core + 66 CLI + 38 app tests passed; 603 total                                                                    |
| Frontend                   | 1,030 tests in 81 files passed in Chromium                                                                            |
| Workers                    | 109 tests in 3 files passed                                                                                           |
| Baseline total             | **1,742 passed**                                                                                                      |
| Additional core probes     | 7 failures: sync application, upload hashes, conflict copies, concurrent writes, symlink traversal, multiline capture |
| Additional Workers probes  | 3 failures: rejected CAS side effects, initial CAS, partial bulk failure                                              |
| Additional frontend probes | 9 failures: save session (4), auto sync (2), editor (3)                                                               |
| Production Vite bundle     | Succeeded; output directory 5.7 MiB on disk                                                                           |
| Version-status measurement | 1/20/200 versions, 256 KiB each, seven calls per fixture                                                              |

Code review covered storage, sync client/Worker, CLI/MCP write paths, save sessions, Workspace, Scrawl, Browse, Markdown/editor plugins, Tauri command dispatch, and build/verification configuration. Android device behavior, real multi-device R2 traffic, crash/power-loss testing, and production authorization settings were not exercised. No production account or note data was used for the reproduction probes. Existing tests use their existing environment; baseline Workers tests loaded local `.dev.vars`. The reproduction harness does not copy that file.

P1 means a data-preservation problem to address before depending on concurrent use. P2 means a conditional correctness, scope, or efficiency problem. Concurrency probe counts are one observed run and may vary with scheduling. The deterministic sequencing probes do not depend on timing luck.

## Findings

### F01 — P1: a rejected server CAS has already changed the object

Source: `workers/src/index.ts:150–167`, `workers/src/sync.ts:135–139,199–204`.

Both clients load the same state/ETag and pass the initial check. A writes its object and commits state. B then overwrites the same object; B's final state CAS fails. The endpoint reports 409, but the bucket contains B's bytes while the accepted state describes A. Readers can download those bytes under the wrong hash/stamp; A's bytes need not exist anywhere in the bucket. An ordinary upload does not create a conflict backup.

**Reproduced:** accepted object `accepted A` becomes `rejected B` after a failed CAS. The test uses the actual bulk/state functions and local R2 conditional puts, with the interleaving made explicit.

Direction: serialize each user's complete mutation transaction, or write immutable content objects and atomically publish references. Moving the existing state CAS earlier by itself is insufficient: it would publish state before objects are ready.

### F02 — P1: first-time state writes have no conditional creation

Source: `workers/src/sync.ts:75–83`.

When `expectedEtag` is null, `saveSyncState` performs an unconditional put. Two clients initializing the same account can both succeed, and the second state replaces the first client's key set. Those omitted keys can subsequently be interpreted as remote deletions.

**Reproduced:** both clients read an absent state and both state saves return true. The second must instead lose the creation race. Address with F01, including the empty-state case in the transaction design.

### F03 — P1: failed bulk requests leave unpublished object changes

Source: `workers/src/sync.ts:142–145,199–204`, `workers/src/index.ts:156–165`.

Uploads, downloads, conflicts, and deletes run concurrently. One missing download rejects `Promise.all`, but completed or still-running writes are not rolled back. The handler returns 400 before committing state. This can follow an object/state inconsistency from F01 or an externally missing object, and also applies to storage failures.

**Reproduced:** a request uploading one existing file and downloading a missing file throws, but the uploaded file has already replaced its previous content. A later retry is not a transaction rollback and cannot recover overwritten bytes by itself.

Direction: include failure atomicity in the same server storage redesign as F01; validate/decode before mutation, but recognize that upfront validation cannot eliminate runtime failures.

### F04 — P1: downloading overwrites an edit saved during the network round trip

Source: `core/src/sync/engine.rs:199–226,470–486`.

The engine decides to download based on a local scan, waits for the network, and then calls `write_under` without checking whether the local file changed. The `.sync.lock` only excludes another sync; app/CLI/widget edits do not take it. A locally successful save can disappear without becoming a conflict copy. The local-delete path has an extra hash check, but downloads do not.

**Reproduced:** scan `old`, write `saved while network request was pending`, apply a remote download; the only local copy becomes `remote`.

Direction: compare and apply under a per-file lock shared by local writers. If local content changed, preserve both versions and keep the key unsettled. A separate hash check without a lock still leaves a check-to-write race. Cover concurrent deletion and creation as well.

### F05 — P1: Note revision checks are not atomic with the write

Source: `core/src/note/repository.rs:252–287,302–309`, `core/src/utils/fs.rs:46–59`.

Multiple writers can read the same content, all pass the revision comparison, and then replace each other using separate atomic renames. Atomic replacement protects readers from half-written files; it does not make read/compare/write atomic. Metadata edits also read and rewrite the whole document without sharing exclusion with body writes. Restore and promotion need the same ownership rules.

**Reproduced:** 12 synchronized writers with one original revision all return success; only one result can remain. The probe enlarges the original body to widen the race window.

Direction: lock the immutable note identity across processes for resolve/read/compare/write, including promotion, deletion, metadata changes, restore, repair, and sync application. Verify that exactly one concurrent writer succeeds and others return `Stale`.

### F06 — P1: simultaneous Scrawl captures silently lose successful records

Source: `core/src/scrawl/repository.rs:23–36,116–139`.

Capture reads a whole day, appends in memory, and replaces the day file. Concurrent captures can start from the same day and overwrite each other's append. Editing/deletion and sync writes share this gap. A source comment already acknowledges the missing exclusion; this audit verifies the consequence, rather than presenting the limitation as newly discovered.

**Reproduced:** 24 successful capture calls leave **2 entries** in the observed run.

Direction: a shared per-day read/modify/write lock, with capture waiting briefly rather than failing just because a whole sync is running. Do not implement a separate process-local mutex that leaves the widget/CLI race open.

### F07 — P1: a stale save of A cancels B's pending save

Source: `tauri-app/src/lib/note-session.ts:292–301,314–317,390–403`.

`settleEdit` does not wait for an already-fired save chain. A user can move to B and type while A's write is in flight. If A later returns `Stale`, `yieldToOutsideEdit` increments a workspace-wide generation and cancels the current timer, even though that timer now belongs to B. Leaving B afterward does not flush it because its timer is gone.

**Reproduced:** start A's save, navigate to B, type B, reject A as stale, advance timers; there is no write for B.

Direction: scope cancellation/generations and dirty state to the note/save target; cover a queued B write as well as B's timer. Merely waiting in one navigation entry point will not cover all asynchronous callers.

### F08 — P1: backup failure is followed by destructive reload

Source: `tauri-app/src/lib/note-session.ts:292–304`.

On `Stale`, `tryWriteBackup` can fail (quota exceeded or unavailable localStorage), yet the function still force-reloads disk content. The warning is shown after the user's only copy has been removed from the editor. Existing refusal wording acknowledges the loss, but does not prevent it.

**Reproduced:** a store throwing `quota` plus a stale save replaces `only copy of my edit` with disk content.

Direction: when persistence fails, retain the unsaved body in the editor or a recoverable in-memory draft and block destructive replacement until the user has an explicit recovery route.

### F09 — P1: ordinary I/O save failures are silently abandoned

Source: `tauri-app/src/lib/note-session.ts:346–365,375–398`.

Errors other than stale/permanent refusal only reset status to idle. There is no recovery copy, error toast, persistent dirty flag, or retry. Once the debounce timer fired, switching notes calls `settleEdit` with no pending timer and loses the failed draft.

**Reproduced:** reject a write with a disk-full-style error, let the timer finish, then navigate; the typed text is neither saved nor in the backup store.

Direction: retain dirty state independently from timer existence, surface the failure, and preserve/retry the draft before navigation.

### F10 — P2: upload bytes and upload hashes come from different reads

Source: `core/src/sync/engine.rs:383–395,409–421`.

The request reads the file again for `content_base64` but uses the earlier scan's hash. An intervening edit produces a valid-looking digest that does not describe the uploaded bytes. The Worker validates hash syntax, not the content/hash relationship. This causes false changes/conflicts and invalidates the meaning of recorded sync state.

**Reproduced:** scan `old`, replace it, build the request; SHA-256(decoded upload) differs from `upload.hash`.

Direction: hash the actual upload buffer and explicitly handle changes since action selection; verify download integrity too. Keep the action decision and state bookkeeping consistent rather than fixing only the payload field.

### F11 — P2: same-second conflict copies overwrite earlier recovery data

Source: `core/src/sync/engine.rs:418,494–498`, `workers/src/sync.ts:158–176`.

Conflict names only distinguish seconds. Both the server backup put and the client's backup `write_under` overwrite an existing destination. The collision-safe helper used for relocating legacy conflicts is not used on this live path.

**Reproduced:** apply two different conflict downloads with the same conflict key; only one backup remains instead of two. The server-side put has the same overwrite behavior by inspection.

Direction: use a genuinely unique conflict identity and no-clobber creation; retries need an explicit idempotency identity so uniqueness does not generate endless copies.

### F12 — P2: Markdown checklists split one Scrawl record into several

Source: `core/src/scrawl/day.rs:166–183`, `core/src/utils/markdown.rs:12–20`.

`split_entries` treats any line beginning `- [` as a new record. Multiline text is stored without escaping or framing continuation lines.

**Reproduced:** one capture containing `Shopping\n- [ ] Milk\n- [x] Bread` reads back as three entries. The original timestamp/context association is no longer one record, and later edits/deletes work on the fragments.

Direction: at minimum distinguish actual timestamp headers from checklist/link syntax; for a full solution define reversible continuation encoding, since user text can also contain a timestamp-shaped line. Include backward-compatible reading in the storage-format work.

### F13 — P2: an older read of the same Note can replace a newer read

Source: `tauri-app/src/lib/note-session.ts:183–198`.

The read guard compares selected ID and typing state, but has no read-request generation. Two loads of the same note, including an A→B→A navigation, can complete in reverse order and install obsolete body and revision. A forced old load also bypasses the typing check.

**Reproduced:** let the second reload finish, then finish the first reload; the first response replaces the second. This is a session-level reproduction; the precise UI navigation schedule was not automated end-to-end.

Direction: attach a monotonically increasing read token/session identity and verify it on completion, including forced loads.

### F14 — P2: edits during a long sync can miss automatic upload

Source: `tauri-app/src/lib/sync.ts:127–150,159–170`.

An edit schedules a five-second timer. If the timer fires while another sync is active, `syncNow` returns. Completion does not reschedule the missed request. When the active round scanned before that edit, the edit remains local until another write or manual sync.

**Reproduced:** start a sync, mutate, advance six seconds, emit completion, advance another six seconds; only one sync was requested.

Direction: track a pending mutation generation while syncing and perform one follow-up sync if it was not included.

### F15 — P2: disabling auto sync does not cancel an existing timer

Source: `tauri-app/src/lib/sync.ts:141–151,188–196`.

The setting changes the signal/config but leaves a scheduled timer active, and its callback does not recheck the setting.

**Reproduced:** mutate, disable auto sync, advance the timer; one `sync_start` still occurs.

Direction: cancel the timer when disabling, and recheck current eligibility in the timer callback. Cover logout/config removal as related state transitions.

### F16 — P2: a reused glyph widget retains its old cursor position

Source: `tauri-app/src/lib/glyph-plugin.ts:71–93`.

The widget's key is only the glyph name, so ProseMirror can reuse its DOM after text is inserted before it. Its `mousedown` closure still captures the original `range.from`.

**Reproduced in Chromium/Milkdown:** insert ten characters before `:star:`, click its image; selection goes to **9 instead of 19**.

Direction: derive the current position through the widget's `getPos` callback, while keeping stable identity for DOM reuse. Also verify repeated occurrences of the same glyph.

### F17 — P2: editor code spans/blocks are decorated as ordinary prose

Source: `tauri-app/src/lib/note-link-plugin.ts:26–44`, `tauri-app/src/lib/glyph-plugin.ts:21–38`.

Note-link traversal does not exclude inline code or code-block descendants. Glyph traversal excludes inline code but still descends into fenced code blocks. Markdown preview explicitly only converts text tokens outside code, so the two surfaces disagree.

**Two Chromium/Milkdown reproductions:** a fenced `:star:` becomes an image, and inline code containing `[[20260920_120000]]` becomes a title chip. The tests establish display/cursor behavior; they do not claim the stored Markdown is rewritten by decorations.

Direction: stop traversal at code blocks and skip inline-code marks; apply the same boundary rules to completion suggestions.

### F18 — P2: sync follows symlinks outside the data directory

Source: `core/src/sync/scan.rs:107–119`, `core/src/sync/engine.rs:436–451`.

The scan follows symlink metadata, recurses into linked directories, and derives keys from the lexical path. A link under `data/` to an outside directory makes that outside content eligible for upload. The download write path similarly validates lexical components without checking the resolved parent directory.

**Reproduced:** a synthetic `data/link` pointing to a sibling `private/` directory causes `private/not-a-note.txt` to appear in the sync scan. Outside writes were identified by inspection, not exercised by this probe. No real private data was read.

This requires a locally present symlink; it is not evidence that a remote client can create a symlink through the bulk API. The source deliberately follows links, so containment policy must be clarified as part of the fix.

Direction: refuse symlinks or explicitly constrain resolved paths beneath the data root for reads, writes, and deletes, with cycle handling if links are supported.

## Efficiency work, in order

### E01 — avoid rereading every Codex version after every save

`note_version_status` (`core/src/note/version.rs:283–295`) calls `list_note_versions`, which reads and parses every version file, then reads the newest version again. Workspace triggers it after every autosave (`Workspace.tsx:484–489`). Opening a Codex also independently requests `list_note_versions` (`Workspace.tsx:348–355`), duplicating the history scan. The Tauri handlers are synchronous (`src-tauri/src/lib.rs:510,567`) while other expensive list/search commands already use `off_main_thread`.

Measured on this machine in the **unoptimized test build**, seven warm calls, median:

| Versions | Body per version | Median status call |
| -------- | ---------------- | ------------------ |
| 1        | 256 KiB          | 0.254 ms           |
| 20       | 256 KiB          | 1.847 ms           |
| 200      | 256 KiB          | 29.648 ms          |

At 200 versions, one status request reads about 50 MiB of history before the extra draft/latest reads. The important finding is read amplification; these times are not release/Android latency estimates.

Direction: cache/index version metadata, invalidate on commit/delete/sync, read only the latest body for dirty/byte comparison, reuse history metadata between status and list, and move blocking work off the command thread. Preserve absolute-time ordering: filename order alone already has a documented timezone discrepancy.

### E02 — cache editor decoration ranges rather than walking the whole document

`note-link-plugin.ts:188–226` and `glyph-plugin.ts:56–98` rebuild decorations from the document and selection. Even the "fast" `doc.textContent.includes(...)` path traverses/concatenates text; it does not avoid document-size work. Link titles use linear `targets.find`, and Workspace rebuilds candidate arrays through an accessor. This work can run for selection changes, not only edits.

Direction: keep ranges in plugin state, map positions with transactions, recompute changed blocks, and cache an ID→title map. Fix F16/F17 first so optimization preserves correct positions and code boundaries. No isolated latency benchmark was run for this path.

### E03 — remove nonessential highlighting work from the first writable frame

`MilkdownEditor.tsx:155` awaits `getHighlighter()` before creating the editor. `highlighter.ts:8–23` imports/initializes two themes and eight language grammars even for plain prose. This is on the "open note, start writing" path.

Direction: measure first-note interactive time on Android, initialize the editable document first, and attach highlighting when ready or load only languages actually used. Preserve IME/selection while doing so. This is a source-grounded opportunity, not a measured startup regression.

Build evidence: entry JS is 91.90 kB (29.48 kB gzip), Workspace 225.04 kB (84.01 kB gzip), MilkdownEditor 126.95 kB (41.48 kB gzip), and the shared note-link-plugin chunk 364.06 kB (109.22 kB gzip). Chunk names do not attribute all bytes to the named source module. The largest diagram chunk is 662.12 kB; Mermaid is already lazy, so that size alone is not evidence of slow initial startup.

### E04 — bound repeated full-tree and full-result work

`search_all` scans all records, allocates all hits, sorts them, then truncates to 100 (`core/src/search.rs:149–192`). Backlinks rescan all records on note selection. `Notes::scan` also asks for Codex version counts even when a consumer only needs searchable body/tags. Browse retrieves the entire result set and renders rows without pagination/windowing.

Direction: establish scale benchmarks first; use bounded top-K search accumulation, metadata/body caches with reliable invalidation, optional version-status enrichment in scans, and windowed large result lists. Avoid adding an index whose invalidation breaks external CLI/sync edits. The existing benchmarks cover search/list/scan but not Codex history growth or the new Browse surface.

## Other inspected risks and acknowledged tradeoffs

These are not included in the 18 reproduced findings:

- MCP/Tauri body-write schemas still permit omitted revisions (`cli/src/server.rs:184–187`, `cli/src/notes.rs:117–123`, `commands.ts:235`). This is documented compatibility behavior but conflicts with the supplied invariant that every writer provides the revision it read. Make the policy explicit before enforcing it, and preserve deleted-note recovery semantics.
- `ALLOWED_SUBS` absent allows any authenticated Google subject while object keys are shared (`workers/src/index.ts:215–230`). Production configuration was not inspected; this is a configuration risk, not a claim that the deployed bucket is exposed.
- Sync HTTP builders have no explicit end-to-end request deadline in repository code. Verify slow/stalled connections and cancellation under the actual HTTP library/platform defaults before reporting a runtime hang as reproduced.
- Startup repair intentionally remains outside the sync lock (`tauri-app/src-tauri/src/lib.rs:197–201`). Coordinate it with the same file/identity ownership design as F04–F06.
- Frontmatter updates deserialize and reserialize typed fields; comments, presentation, and unknown keys are not preserved verbatim. Existing rules also explicitly say unknown keys are dropped. Resolve this specification tension rather than treating every formatting difference as a new regression.
- Codex list dirty indicators use filename wall-clock order while detailed history uses absolute timestamps; this is explicitly acknowledged in `version.rs:310–313`.

## Suggested issue/implementation grouping

1. **Server sync transaction consistency** — F01–F03. Include absent state, competing uploads/deletes, partial failure, and response loss/retry.
2. **Shared storage exclusion and sync application** — F04–F06. Preserve capture responsiveness and cover promotion/metadata/restore, not just body writes.
3. **Per-note pending saves and recoverable failures** — F07–F09, F13. Keep dirty state independent from timers; protect unsaved buffers.
4. **Sync payload and recovery integrity** — F10–F11; optionally F18 after deciding symlink policy.
5. **Scrawl multiline framing** — F12, with old-file compatibility fixtures.
6. **Auto-sync lifecycle** — F14–F15.
7. **Editor decoration correctness** — F16–F17; then E02.
8. **Codex status I/O** — E01, measured before/after in release builds and on a target phone.

The first three groups are the recommended first issues. Existing comments acknowledge some related gaps; this audit did not query remote issues for deduplication. This report records findings and reproduction probes; production fixes require separate changes.

## Reproduction

From the repository's development environment, with its already installed Rust/Node dependencies and Chromium:

```sh
go run docs/audits/2026-09-20/reproduce.go -prepare-only
go run docs/audits/2026-09-20/reproduce.go
```

The first command only prepares a fresh temporary snapshot. The second prepares another snapshot and runs all audit tests, continuing after failed suites. It exits nonzero on the audited revision because the assertions state the desired preservation/correctness properties. Use `-ref <commit>` to audit a later commit. It shares installed `node_modules` and Cargo's target cache, but places added test sources and output logs in the temporary snapshot. It does not copy `.dev.vars`.

`reproduce.go -prepare-only` was itself verified. The test files were executed individually during the audit; the combined runner was not rerun after packaging, to avoid repeating the same checks. A restrictive sandbox may require allowing local test-server sockets and tool caches.

The [reproduction driver](reproduce.go) writes fresh `core.log`, `workers.log`, and `frontend.log` inside the printed temporary snapshot. The [test sources](tests/) preserve the assertions and controlled interleavings. Original machine-specific logs remain in the ignored local `sample/audit-2026-09-20/logs/` directory; they are not required to run the probes.
