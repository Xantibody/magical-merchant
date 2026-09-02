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

## MCP CLI

`mcp-cli/` exposes core as read-only MCP tools (`server.rs`; output shapes
in `output.rs`): `list_notes`, `read_note`, `backlinks`, `search`,
`list_timeline_dates`, `read_timeline`, `read_timeline_range`, `list_places`,
`list_tags`, `list_templates`, `read_template`. Timeline entries go out as
values (`parse_timeline_entry` in core), never as raw lines — external
consumers join on time and location, so keep those fields structured. Place
names come only from the app's `places.json` cache; the server must stay
offline. New core read APIs should be considered for MCP exposure.

Write tools (`create_note`, `update_note`, `list_note_history`,
`read_note_history`, `restore_note`) exist only behind `--allow-write` and
are removed from the router otherwise — never listed-but-refused. Every
overwrite goes through `snapshot_note` first (`core/src/note/history.rs`,
`<base>/history/<stem>/<id>.md`, outside the synced `data/`), and writes
always use core's note functions so the frontmatter stays compliant. No
delete tool; do not add one without discussion. Packaged as
`nix run .#mcp` (`nix/mcp.nix`).

## Verification

- `just verify` = fmt → check → test; CI mirrors `just fmt/check/test` with
  path filters
- Rust: `just rust::check` (clippy) / `just rust::test`
- Frontend: `just tauri_app::check` (oxlint + tsgo) / `just tauri_app::test` (Vitest)
- Browser harness: `just tauri_app::dev-browser` (Vite + IPC mock,
  `BROWSER_MOCK=1`); fixtures are deterministic — extend them when adding
  commands. The mock never reaches production builds
- CSS conventions have tests (`styles/*.test.ts`) — update them when changing
  layout rules they assert
