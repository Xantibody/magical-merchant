---
name: rust-core
description: Rust core crate conventions, Tauri command plumbing, MCP CLI, and the verification workflow. Use when adding commands, core logic, or tests.
---

# Rust Core & Plumbing

## Layering

- `core/` is framework-independent business logic — no Tauri types. It is
  consumed by the Tauri app, the MCP CLI, **and Android JNI** (widget capture),
  so keep entry points free of app-only assumptions
- `tauri-app/src-tauri/` wraps core functions as Tauri commands
- Frontend calls go through `typedInvoke` (`lib/commands.ts`) — add the
  command's types there, never call `invoke` raw

## Adding a Tauri command — checklist

1. Core logic + unit tests in `core/`
2. Command in `src-tauri`
3. Types in `lib/commands.ts` (`typedInvoke`)
4. **Handler in `tauri-app/dev/ipc-mock.js`** — unknown commands throw in the
   browser harness so the gap is visible
5. If it reads/writes notes: respect storage invariants (sync-storage skill)

## CLI (`cli/`, binary `magical-merchant`)

One binary, two jobs. `commands.rs` holds `list` / `show` / `edit` / `new` /
`import`; `edit` writes the body (never the frontmatter) to a scratch file,
runs `$VISUAL` / `$EDITOR` (`editor.rs`), and writes back only if the body
changed. `notes.rs` is the shared write path — creation (empty body refused,
path turned back into the note's ID) and overwrites (snapshot, revision
check, core `update_note`) — used by `new` / `import` / `edit` and the MCP
`create_note` / `update_note` tools; never write a note from the CLI or MCP
any other way. Each caller names its own `Source`. `import` additionally
carries the creation time (core `create_note_at`): a note's filename is its
creation time and its permanent ID, so a note written elsewhere can only
keep its date if the creating call takes one. It reads the body from stdin
and prints the filename; quirks of any particular source format belong in a
conversion script, not in the binary. A refused edit
(stale, empty, editor failure) keeps the scratch file and prints its path.
The editor launch is a closure parameter so the flows are unit-tested
without an editor. `timeline.rs` holds `timeline add / show / dates`;
`add` only appends (same core call as the Android widget), so it carries
no revision. Entry editing by index is deliberately absent — an index
shifts under a concurrent append.

`sync.rs` is the `sync` subcommand: resolve `sync-config.json` + the stored
JWT, then core's `engine::run_with_progress`. It only ever **reads** the
config and the token — setting the server up and logging in stay in the app,
so there is one place either can be changed. The `kind`s it produces
(`notConfigured` / `notAuthenticated`) match the app's `do_sync`; keep them
in step. It is the only CLI command needing core's `sync-client` feature,
which is why the CLI now pulls in reqwest and keyring.

The MCP server runs only under the `mcp` subcommand (a bare invocation
prints help). `nix run .#mcp` is a wrapper that adds the subcommand.

`server.rs` exposes core as read-only MCP tools (output shapes
in `output.rs`): `list_notes`, `read_note`, `backlinks`, `search`,
`list_timeline_dates`, `read_timeline`, `read_timeline_range`, `list_places`,
`list_tags`, `list_templates`, `read_template`, `list_glyphs`. Timeline entries go out as
values (`parse_timeline_entry` in core), never as raw lines — external
consumers join on time and location, so keep those fields structured. Place
names come only from the app's `places.json` cache; the server must stay
offline. New core read APIs should be considered for MCP exposure.

Write tools (`create_note`, `update_note`, `list_note_history`,
`read_note_history`, `restore_note`, `save_glyph`) exist only behind
`--allow-write` and are removed from the router otherwise — never
listed-but-refused (`WRITE_TOOLS` in `server.rs`; extend it when adding
one). Every note overwrite goes through `snapshot_note` first
(`core/src/note/history.rs`, `<base>/history/<stem>/<id>.md`, outside the
synced `data/`), and writes always use core's note functions so the
frontmatter stays compliant. No delete tool; do not add one without
discussion. Packaged as `nix run .#cli` (`nix/cli.nix`); `.#mcp` wraps it.

Glyphs (`core/src/glyph.rs`): user images under `data/glyphs/<name>.<png|svg>`
that `:name:` renders inline. `GlyphName` (`utils/validated.rs`) fixes the
charset — the same regex lives in `lib/glyphs.ts`; fix both. Only registered
names resolve, so the tokenizer never touches `12:30:45`.

## Verification

- `just verify` = fmt → check → test; CI mirrors `just fmt/check/test` with
  path filters
- Rust: `just rust::check` (clippy) / `just rust::test`
- Frontend: `just tauri_app::check` (oxlint + tsc) / `just tauri_app::test` (Vitest)
- Browser harness: `just tauri_app::dev-browser` (Vite + IPC mock,
  `BROWSER_MOCK=1`); fixtures are deterministic — extend them when adding
  commands. The mock never reaches production builds
- CSS conventions have tests (`styles/*.test.ts`) — update them when changing
  layout rules they assert
