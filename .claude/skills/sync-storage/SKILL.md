---
name: sync-storage
description: Note/timeline storage invariants, sync protocol, widgets and deep links. Use when touching file formats, frontmatter, sync, conflict handling, or Android widgets.
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
- **`view`** (optional frontmatter): per-note display mode (`mindmap`).
  A preference, not a record — omitted unless set so untouched notes stay
  byte-identical
- Any new frontmatter key must be a **typed field on `NoteFrontmatter`** in
  Rust core; unknown keys are dropped on the next save
- **Tags** come from the body's `#記法`. Identity is the ASCII-lowercased form
  (`#Rust` = `#rust`; Japanese is left alone) and code — fences and spans — is
  not scanned. The same rule lives twice: `core/src/utils/tags.rs` and
  `lib/tags.ts`; fix both
- **Place names** (`places.json`, outside `data/`): derived geocoder cache,
  display-only. The recorded `location` stays the raw coordinate

## Sync protocol (Workers + R2)

The Worker owns sync state: `_sync-state/<user>.json` maps every key to a
content hash + server-issued version stamp. One sync = `GET /sync-state` →
local scan → diff → one `POST /sync/bulk`.

| Client sees                 | Action                           |
| --------------------------- | -------------------------------- |
| Hash differs                | Upload (new hash, new stamp)     |
| Stamp differs               | Download                         |
| Both differ                 | Conflict — local wins, new stamp |
| Gone locally, stamp matches | Delete remote                    |
| Gone remotely, hash matches | Delete local                     |

- The client **never sends its own state** (would read undownloaded keys as
  deletions and erase notes everywhere)
- Writes use `expected_etag` compare-and-swap; losing races retry
- Conflicts keep the loser as `….sync-conflict-<ts>.md` in R2 and on disk;
  conflict copies are excluded from scanning
- Auto sync runs a few seconds after any successful write
- JWT: macOS Keychain; Android falls back to app-private file (mode 600) —
  keyring's in-memory fallback silently loses tokens

## Widgets & deep links

- Timeline capture widget appends via **JNI directly into core** — the app
  never starts. Core changes must stay callable from JNI
- "New note" / recent-notes widgets open `magical-merchant://widget/…` deep
  links; handled in AppLayout (`onOpenUrl` + `getCurrent` for cold start);
  note rows navigate with `?file=<filename>`
- Widget sources live in `tauri-app/android-widget/`, injected by
  `just android-widget-setup`
