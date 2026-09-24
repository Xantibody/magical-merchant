---
name: sync-storage
description: Note/Scrawl storage invariants, sync protocol, widgets and deep links. Use when touching file formats, frontmatter, sync, conflict handling, or Android widgets.
---

# Storage & Sync

## Note storage invariants

- **Filename** `YYYYMMDD_HHMMSS.md` is an immutable ID stamped at creation.
  Syncthing, widget deep links (`?file=`) and list-row identity all point at
  it. Never rename to match the title
- **Title** = the body's leading `# heading` (`note-title.ts` splits it out for
  the title field and writes it back on save). Never a frontmatter key — one
  source of truth, and the file stays readable elsewhere. The list still
  derives its row title from the first body line
- **Frontmatter** (`time`/`tags`/`context`) is a record of creation, preserved
  verbatim on every edit. `time` must stay the creation time (list sorts by
  filename = creation order)
- **`updated`** (optional frontmatter): when the body was last rewritten.
  Stamped only by `Notes::update` — metadata edits and view toggles are not
  rewrites. Absent until the first edit, like `view`
- **`view`** (optional frontmatter): per-note display mode (`mindmap`,
  `preview`). A preference, not a record — omitted unless set so untouched
  notes stay byte-identical. Unknown values resolve to the editor, so a new
  value never breaks an older build
- Any new frontmatter key must be a **typed field on `NoteFrontmatter`** in
  Rust core; unknown keys are dropped on the next save
- **Revision guard**: `read_note` returns `Revision::of(body)`; every body
  write passes it to `update_note`, which refuses with `CoreError::Stale`
  if the body moved. The app parks the typed text in the edit backup and
  reloads; the CLI keeps it in a scratch file; MCP returns the error. The
  revision covers the body only, so metadata edits never make a save stale.
  No writer watches the filesystem — this guard is the only protection
- **Tags** come from the body's `#記法`. Identity is the ASCII-lowercased form
  (`#Rust` = `#rust`; Japanese is left alone) and code — fences and spans — is
  not scanned. The same rule lives twice: `core/src/utils/tags.rs` and
  `lib/tags.ts`; fix both
- **Place names** (`places.json`, outside `data/`): derived geocoder cache,
  display-only. The recorded `location` stays the raw coordinate. Keyed by
  `<locale>:<coordinate>` — the OS answers in whatever language it was asked,
  so the language has to be part of the key

## Sync protocol (Workers + R2)

The Worker owns sync state: `_sync-state/<user>.json` maps every key to a
content hash + server-issued version stamp. One sync = `GET /sync-state` →
local scan → diff → `POST /sync/bulk`, repeated until nothing is left over.

| Client sees                 | Action                            |
| --------------------------- | --------------------------------- |
| Hash differs                | Upload (new hash, new stamp)      |
| Stamp differs               | Download                          |
| Both differ                 | Conflict — local wins, new stamp  |
| Gone locally, stamp matches | Delete remote                     |
| Gone remotely, hash matches | Delete local                      |
| No state, hashes match      | Nothing to transfer — record only |

- The client **never sends its own state** (would read undownloaded keys as
  deletions and erase notes everywhere)
- **A bulk is capped at 40 R2 operations** (`core/src/sync/round.rs`), because
  Workers Free allows 50 subrequests per invocation and the Worker touches R2
  once per file (three times per conflict, once for all remote deletes). The
  engine loops rounds until nothing is deferred; the Worker refuses more than
  45 with 413. A key carried to the next round **keeps its record from before
  the sync** — recording the server's version makes the old copy still on disk
  look like a local edit, and the next round uploads it over the newer remote
  one. `kind: "stalled"` means a round sent nothing while work remained
- Writes use `expected_etag` compare-and-swap; losing races retry
- **One sync per data directory**: `engine::run` takes an exclusive lock on
  `<base>/.sync.lock` at its entry (`core/src/sync/lock.rs`) and fails with
  `kind: "busy"` if another process holds it. The app's `AtomicBool` only
  drives the "syncing" indicator; the file lock is the authority. Both the
  app and `magical-merchant sync` start syncs, so the loser really does get
  `busy` — the CLI says so and exits 1, the app stays quiet
- **Repair runs under that lock**, never outside it: `repair_tree` in
  `engine.rs` (the `data/timeline/` → `data/scrawl/` move, malformed notes,
  legacy conflict copies, duplicate IDs) fires right after the lock is taken
  and before the first scan, and the duplicate-ID pass runs again before a
  successful sync returns. A caller cannot take the lock on the engine's
  behalf — it is a flock on the engine's own descriptor, so the engine would
  then answer `busy` to itself
- **`data/timeline/` is the pre-rename name of `data/scrawl/`.**
  `migrate_scrawl_dir` moves it, and every entry that can write a day file
  calls it before reading: the sync lock, app start, CLI start, the widget's
  JNI. The remote sees the move as `UploadNew` on the new keys plus
  `DeleteRemote` on the old ones, so one sync finishes it — but a device still
  on an older build then loses its `data/timeline/` to that delete and shows an
  empty Scrawl until it is updated. Same-named days are left in the old
  directory rather than merged; day files grow by appending
- Conflicts keep the loser as `….sync-conflict-<ts>.md` in R2, and on disk
  as `conflicts/<key minus extension>/<ts>.md` — outside `data/`, same shape
  as `history/`, so it neither syncs back nor lands in the notes list.
  The name is built and read back in `core/src/sync/conflict.rs` only.
  `<ts>` is precise to the second, so two copies of one key can want the same
  name: a relocation never overwrites, the second takes `<ts>-2.md`
  (`rename_without_clobber` in `core/src/utils/fs.rs`)
- Auto sync runs a few seconds after any successful write
- Sync on start (`sync_on_start`) runs one round at start-up, after the event
  listeners are in place, and on each return to the foreground at most once
  a minute (`resume` in `lib/sync.ts`, called from `AppLayout`'s return hook)
- `data/codex/` syncs like everything else under `data/`: the Codex file and
  its `codex/<stem>/*.md` versions are ordinary keys. A build that predates
  Codex simply never lists that directory. The sync engine runs
  `relocate_duplicate_ids` under the lock (the app also runs it once at
  startup, for the note list): promotion on one
  device plus an offline edit on another can land the same ID in both
  `notes/` and `codex/`; the Codex wins and the `notes/` copy goes to
  `conflicts/notes/<stem>/<ts>.md`
- `history/` (local, machine-taken before an overwrite) and `data/codex/<stem>/`
  (synced, committed by a person) are different things; never move one into
  the other. A note's filename never changes, but its directory does move once,
  `notes/` → `codex/`, on promotion
- JWT: macOS Keychain; Android falls back to app-private file (mode 600) —
  keyring's in-memory fallback silently loses tokens
- TLS: desktop verifies through the OS trust store (rustls-platform-verifier);
  Android uses `webpki-roots` for the sync client because the platform
  verifier reports OCSP-less certificates as Revoked
  (`android_tls::sync_tls_config`, `tauri-app/android-tls/README.md`)

## Widgets & deep links

- Scrawl capture widget appends via **JNI directly into core** — the app
  never starts. Core changes must stay callable from JNI
- "New note" / recent-notes / templates widgets open
  `magical-merchant://widget/…` deep links; handled in AppLayout (`onOpenUrl`
  and `getCurrent` for cold start); note rows navigate with `?file=<filename>`,
  template rows with `?name=<stem>`
- Widget sources live in `tauri-app/android-widget/`, injected by
  `just tauri_app::android-setup` (`apply-widget.go` registers the four
  receivers in the manifest)
