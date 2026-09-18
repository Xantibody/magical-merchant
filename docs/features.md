# Feature Tour

A walkthrough of every surface in Magical Merchant. Screenshots are taken
from the browser verification harness with fixture data.

## Scrawl — a journal that captures first

Scrawl (formerly Timeline) is a single-column, day-grouped journal. The capture bar at the
bottom is always ready: type, send, and the entry lands on today with a
timestamp. Entries record the device context they were written in (device,
network, battery, and a place name resolved from the coordinate), tags typed
as `#tag` become filter chips, and the calendar button jumps to any recorded
day.

![Scrawl](images/timeline.png)

At the top, a **weekly digest** appears once per week: how many entries on how
many days, the most used tags (tap to filter), and — when that day has
entries — a jump to _one year ago today_. Dismissing it hides it for the rest
of the week, per device.

### Mobile

The same journal on a phone. Bottom tabs switch between Scrawl, Note, Codex
and Settings; the capture bar floats above the keyboard.

![Scrawl on a phone](images/mobile-timeline.png)

### Promote an entry into a note

When a quick capture grows into something bigger, promote it: hover an entry
(PC) or long-press it (touch) and choose ノートにする. A new note opens ready
to write, carrying the entry text and tags. The note's frontmatter records the
origin entry, and the timeline shows a chip (📄 title →) on that day linking
to the note — derived on every render, so reordering or deleting entries never
breaks the link.

## Note — a Typora-style Markdown workspace

Note (formerly Notes) holds plain Markdown files. The list pane gives each
note one line, grouped by how recently it was created; the detail pane shows
the body with a **title field** above it. The title is the note's leading
`# heading` — there is no separate title in the frontmatter, so the file
stays readable in any Markdown tool and the heading can never drift from
the title. Press Enter in the field to drop into the body.

**There is no edit mode.** The editor is live from the moment the note is
open — what you see is already the thing you type into, so there is no button
to find and no state to be in the wrong one of. Saving is automatic
(debounced), and the first content-changing save of a session keeps the
pre-edit body on the device, so the `…` menu's 編集前に戻す (`⌘⇧R`) can undo
an accidental edit — press it again to swap back.

Everything else a single note needs is behind that one `…` button (`⌘.`),
because none of it is used often enough to sit in the way of writing: lay the
map alongside, make the note read-only, revert, ノート情報, delete, and — for
a Note — Codex にする.

The ノート情報 panel is also where a note's records live: the creation time
(editable), the tags, the device context it was captured on, and — once the
body has been rewritten at least once — the **update time**. Creation time is
pinned to the filename order, so the update time is the only place a rewrite
shows up. Changing metadata or the view mode is not a rewrite and leaves it
alone.

A note that is done being written can be parked in a **read-only view** —
`…` → 読み取り専用にする, frontmatter `view: preview`. The editor is not
raised at all: the body is a rendered page, the title field is fixed, and the
list row wears a small padlock so you know before you open it. The choice
lives in the file, so it follows the note to every device.

![Editor with note links](images/editor-links.png)

Code blocks are highlighted with Shiki; a ` ```diff ` fence colours its `+`
and `-` lines instead. ` ```mermaid ` fences render as diagrams, and a leading
`%% caption: …` comment inside the fence becomes the figure's caption —
mermaid skips `%%` lines, so the note still draws anywhere else. Hovering a
code block or a figure reveals a small toolbar: copy the code, or open the
diagram full screen and save it as SVG or PNG (the file is named after the
note and the diagram's position). The full-screen view zooms around the
cursor with the wheel or a pinch, drags to pan, and closes with Esc. A
per-note **map** — `…` → マップを並べる (`⌘⇧M`), frontmatter `view: mindmap` —
turns the heading and list structure into a markmap. It is laid _alongside_
the body rather than in place of it, so the text you are reading it against
stays on screen; only below 1100px, where there is no room for two, does it
take the body's place:

![A note with its markmap alongside](images/mindmap.png)

## Note links and backlinks

Type `[[` in the editor and an autocomplete popup offers your notes. The
stored form is `[[YYYYMMDD_HHMMSS]]` — the filename is an immutable ID, so
links survive title changes. The editor and preview render links as the
target's current title; click one to open the note. Write
`[[YYYYMMDD_HHMMSS|display text]]` when the title does not fit the sentence —
the link still points at the same note. A link whose target is gone stays
visible as its raw stored form rather than pretending to be a note.

![Resolved note links](images/note-links.png)

Every note shows the records that link to it — other notes and timeline
entries alike — in a collapsible リンクされている記録 footer. Backlinks are
derived by scanning at read time; there is no index to corrupt or sync.

![Backlinks](images/backlinks.png)

## Codex — a Note that keeps growing

Some notes are never finished: a reading log, a project journal, a page you
keep adding to. Codex is its own tab (Scrawl → Note → Codex) for exactly
those. Any Note becomes a Codex from its `…` menu; the file keeps its ID and
every link to it, it just moves from `data/notes/` to `data/codex/`. The move
is one-way — a Codex is defined by the history it accumulates, and that
history has nowhere to go if the document turns back into a plain Note.

A Codex opens in the same editor as a Note — same title field, same
always-open body, same autosave. What it adds is on purpose: the body is a
draft until you commit a version, and the versions travel with the file
through sync, so the history is the same on every device.

Three things tell a Codex from a Note, and none of them is a mode you have to
enter:

- **The list row** carries a folded-corner page with the number of versions
  in it. Its frame says which of three states the document is in — no
  versions yet, versions and the draft matching the newest one, or the draft
  having moved on since then. The row stays one line.
- **A spine** stands to the left of the body: a narrow rail of dots, one per
  version, while you write, widening into the version list when you open the
  history. It needs room to stand beside the body, so it is absent on phones,
  and below 1100px it stays collapsed and the history arrives as a horizontal
  card under the title that you drag or tap to send versions.
- **The meta line** under the title reads how far the draft has travelled and
  how often you commit — 版 4 から +312 B · 9 か月で 4 回刻んだ
  ("+312 B since v4 · 4 versions in 9 months"). A draft that matches the
  newest version says only 版 4; a Codex with no versions says 版なし.

Nothing is committed for you, and committing asks nothing of you. 版を刻む in
the `…` menu (`⌘⇧K`) flushes whatever save is still in flight and writes the
version at once — no message prompt, because a version is named by its number
and its day, and being asked for a sentence is what stops people committing at
all. The toast that follows does the summarising (版 5 を刻みました · 版 4 から
+312 B · 7 日ぶり) and carries an Undo that deletes the file just written.

履歴 in the same menu opens the spine rather than replacing the body. The body
stays where it is and turns read-only, and the difference between the version
you picked and the draft appears in its margin: a `+` beside every block that
changed, a `−` beside every block that is gone — struck through and faint, in
the place it used to occupy. Walk the versions with the spine (`↑`/`↓` once
a row has focus) or with the card, and the marks move with them; `Esc`
closes the history and the editor comes back. この版に戻す makes that version
the draft again, and the draft you are leaving is committed first as
_before restore_, so a restore is itself undoable from the same list. A read-only Codex cannot be restored, for the
same reason it cannot be edited.

On disk a version is
`data/codex/<id>/<YYYYMMDD_HHMMSS>-<first 8 hex of the body's SHA-256>.md`:
plain Markdown with `time` and `message` frontmatter, so `diff -u` in a
terminal works as well as the app does. The app leaves `message` empty — the
only one it writes is `before restore`, and the history shows that version as
戻す前 instead of a date. Two devices committing the same body in the same
second land on the same file, which is the same version, so it folds into one.
Versions are not the local `history/` copies the CLI and MCP take before
overwriting — those are a safety net on one device; versions are part of the
document and sync with it.

## Glyphs — your own inline symbols

Some things have no character: fighting-game command notation, a custom
mark, a logo. Register a small PNG or SVG under a short name in
Settings → GLYPHS and write `:name:` anywhere — a note or a timeline entry —
to show it inline, the way an emoji shortcode works. The preview, the
editor and the timeline all render it; the editor shows the source text
again when the caret touches it, so the stored Markdown stays plain text.

Only registered names render: `12:30:45` and an unknown `:foo:` stay as
written, and a shortcode inside a code span or fence is left alone. The
images live under `data/glyphs/` next to the notes, so sync carries them to
every device; a device that has not received an image yet simply shows the
text. Names are lowercase (`a-z 0-9 _ + -`, up to 32 characters) and images
are capped at 256 KB. To register many at once, pick a whole folder (or
several files) — each PNG/SVG is named after its file stem, an existing name
is overwritten, and anything unusable is counted as skipped; files dropped
straight into `data/glyphs/` are picked up as well.

## Search palette

`⌘K` opens the palette. Before you type anything it offers entry points:
recent notes, today/yesterday (only when they have entries), and your most
used tags. Search results highlight the matched text in a context snippet, and
selecting a hit lands exactly — a note opens that note, a timeline hit scrolls
to that day.

Searches can be scoped to tags, from any screen. Every `#tag` you type in the
palette counts as scope rather than text: `#SF6 #ベガ #置き攻め` lists every
note and entry carrying all three tags (AND), and `#sf6 コンボ` looks for
"コンボ" only inside `#sf6`. Tags are matched the way the Scrawl chips are,
so `#SF6` and `#sf6` are the same tag. Picking a tag from the entry points adds
it as a chip in front of the input; a chip is removed by clicking it, or with
Backspace in an empty field (last chip first). When Scrawl is filtered
by a tag, `⌘K` opens the palette with that chip already set. Scoped results
show their count, and the empty message names the tags it looked inside.

![Command palette](images/palette.png)

The palette also lists the app's **commands** — new note, the three modes,
sync now, settings — each with its key down the right-hand side.

## Keyboard

There is no cheat sheet to look up, because the app can show you the keys in
the place they belong. Hold ⌘ (Ctrl on anything that is not a Mac) for a
moment and a badge floats on the shoulder of every button that has one, with
a pill explaining how to make them go away; let go and they are gone. And
`?`, pressed anywhere you are not typing, opens the palette on that command
list.

The ones worth learning first:

| Key                | What it does             |
| ------------------ | ------------------------ |
| `⌘K`               | The search palette       |
| `⌘N`               | A new note               |
| `⌘1` / `⌘2` / `⌘3` | Scrawl / Note / Codex    |
| `⌘.`               | The open note's `…` menu |
| `⌘⇧S`              | Sync now                 |

The rest are in that same list: `⌘,` for Settings, and — with a note
open — `⌘⇧M` for the map, `⌘⇧R` to revert, `⌘⇧I` for ノート情報, `⌘⇧K` to
commit a Codex version, and `⌘↑` / `⌘↓` to walk the list pane without
leaving the body. Where a Mac reads ⌘⇧, every other platform reads
Ctrl+Shift.

The badges, the palette's right-hand column and the key handling all read one
table in [`tauri-app/src/lib/shortcuts.ts`](../tauri-app/src/lib/shortcuts.ts),
so a key that is written in two places cannot come to mean two things.

## Language

The interface speaks Japanese or English. It follows the system language on
first launch and can be pinned either way in Settings → LANGUAGE; the choice
takes effect immediately, without a restart. Place names follow it too: the
OS geocoder is asked in the chosen language, and the cache remembers which
language each answer came from. Only the interface changes — what you wrote
stays exactly as you wrote it, and so do your tags and the coordinates behind
those place names.

On macOS, Settings → WINDOW adds _Start in fullscreen_: the app opens in the
native fullscreen (its own Space, like the green button) from the next launch.

## Sync (optional)

A Cloudflare Worker + R2 backend syncs the Markdown files across devices.
Conflicts keep the local copy and preserve the loser under `conflicts/`,
outside the synced tree. See [sync.md](sync.md) for deployment and the
change-detection protocol.

## Android widgets

Four home-screen widgets ship with the APK:

| Widget             | Size | What a tap does                                                                                                              |
| ------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| タイムラインに記録 | 4×1  | Opens a sheet over the home screen and appends to today's Scrawl through a JNI call into the core — the app is never started |
| 新しいノート       | 4×1  | `magical-merchant://widget/new-note`                                                                                         |
| 最近のノート       | 4×2  | The four newest notes; a row opens that note, the header plus makes a new one                                                |
| テンプレート       | 4×3  | Three templates; a row creates today's note from it (or opens the one that already exists)                                   |

All four are deep links into the app except the capture bar, which is the one
that exists so that recording costs nothing — no launch, no wait.

## Terminal (CLI)

`magical-merchant` is a small command-line client over the same core, for
the days you would rather write in your own editor:

```sh
nix run github:Xantibody/magical-merchant#cli -- list
magical-merchant show                  # the newest note
magical-merchant edit 20260320_143045  # opens it in $VISUAL / $EDITOR
magical-merchant edit --last           # the newest note; `edit` never guesses
echo "# Idea" | magical-merchant new   # or: magical-merchant new --title Idea
magical-merchant import --time 2019-05-04T12:00:00+09:00 < old-note.md  # keeps that time as the ID
magical-merchant timeline add -m "shipped it #work"   # capture; without -m, opens the editor
magical-merchant timeline show [2026-03-20]           # one day, today if omitted
magical-merchant sync                  # same sync the app runs, without opening it
```

`edit` hands the editor the Markdown body only — the frontmatter is the
app's record and is never shown — and writes it back through the same path
the MCP tools use: a copy of the previous version goes to `history/` first,
and the write is refused if the note changed while the editor was open (in
the app, by a sync, by an agent). Nothing typed is lost: the edited text
stays in a scratch file whose path is printed. Closing the editor without
changes writes nothing. The app, in turn, refuses to overwrite a note the
CLI changed while it was open, reloads it, and keeps the typed text behind
its Revert button.

`import` is the way in for notes written somewhere else. A note's filename
is its creation time and its permanent ID, so anything moved in would
otherwise be stamped with the day it was moved; `--time` keeps the day it
was written, `--tag` and `--template` fill in the frontmatter, and the
filename it lands under is printed so a migration script can keep a map.
The body comes from stdin only — nothing about any particular source
format lives in the app, which is a conversion script's job.

`sync` runs the app's own sync engine from the terminal, reading the server
URL and the login the app saved — it never asks for either, so there is one
place where sync is set up — and it stops with "log in again from the app" as
soon as that login has expired. A large sync goes in rounds of at most 40
operations (an upload or a download is one, a conflict three), and each round
prints how far it got and how much it deferred to the next one; the app runs
the same rounds behind its button, silently. Anything short of a clean sync
exits non-zero; a run that reaches the end also lists the files it could not
handle, while one that gives up part way prints only why it stopped. If the
app is syncing at that moment, the CLI says so and exits 1 rather than
waiting.

`timeline add` appends to today through the same core call the Android
widget uses; it only ever appends, so it needs no revision check. `-m` is
the one-liner, a pipe is read as the entry, and with neither the editor
opens.

Anything written from the terminal records the same device context the app
records — OS and version, machine name, locale, battery, and network type —
so what a record says about the machine does not depend on which surface
wrote it. The coordinate is the exception: measuring one costs a permission
prompt and a wait that a command running once cannot pay, and reusing the
app's last fix would claim you wrote somewhere you were not, so records
written from the terminal carry no location.

The CLI finds the app's data directory on its own; `--data-dir` or
`MAGICAL_MERCHANT_DATA_DIR` overrides it.

## AI access (MCP)

`magical-merchant mcp` exposes the same core as
[Model Context Protocol](https://modelcontextprotocol.io/) tools for AI
assistants; `nix run …#mcp` is that command. It is read-only by default and
says so in the instructions it hands the client. It finds the app's data
directory on its own, so the usual client configuration is just the launch
command:

```json
{
  "mcpServers": {
    "magical-merchant": {
      "type": "stdio",
      "command": "nix",
      "args": ["run", "github:Xantibody/magical-merchant#mcp"]
    }
  }
}
```

Every record comes back with the device state captured when it was
written — local time, GPS coordinates (and the place name the app resolved
for them), battery, network type, and which device wrote it — so an agent
can line the journal up with other time- or location-based data.

| Tool                  | Description                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `list_notes`          | List all notes with their `kind` (`note` / `codex`), tags, a short preview, and their origin         |
| `read_note`           | Read a note's metadata (time, tags, context) and Markdown body                                       |
| `backlinks`           | List the records that link to a note with `[[…]]`                                                    |
| `search`              | Search notes, codex and timeline entries, optionally within a set of tags; each hit says which it is |
| `list_timeline_dates` | List the dates that have timeline entries                                                            |
| `read_timeline`       | Read one day's entries with time, text, tags, location, and device                                   |
| `read_timeline_range` | Read entries between two days, optionally filtered by tag                                            |
| `list_places`         | Places (~1 km cells) records were written at, with names and counts                                  |
| `list_tags`           | Every `#tag` with note and entry counts                                                              |
| `list_templates`      | List note templates                                                                                  |
| `read_template`       | Read a template's body and tags                                                                      |
| `list_glyphs`         | Registered glyphs with the `:name:` shortcode that renders each one                                  |

A Codex is visible but not writable as one: an agent can see that a
document keeps versions, read it and search it, but there is no tool to
commit, list, diff or restore a version. Committing is a person saying
"this far", which is not a decision to hand to a model; the versions are
plain Markdown under `data/codex/<id>/`, so an agent that has been given
the data directory can still read them with `diff -u`.

With `--allow-write` the server also offers writing tools, and its
instructions say so instead of claiming to be read-only. Notes are
plain Markdown, so a body can hold anything the app renders — Mermaid
diagrams in a fenced `mermaid` block, `[[YYYYMMDD_HHMMSS]]` links to other
notes, `#tags`, `:name:` glyph shortcodes (ask `list_glyphs` for the
vocabulary). The server writes the frontmatter itself and keeps it intact
on updates; the body is all a client sends.

Every overwrite first saves a full copy of the previous version under
`<data-dir>/history/` (outside the synced `data/`), so any change an
assistant makes can be brought back. The newest 20 copies of each note are
kept; older ones are dropped as new copies arrive, and a note's copies
outlive the note itself. `read_note` also returns a `revision`
of the body; pass it to `update_note` and the write is refused if the note
changed in between (in the app, from the CLI) instead of overwriting that
edit:

| Tool                | Description                                                          |
| ------------------- | -------------------------------------------------------------------- |
| `create_note`       | Create a note from a Markdown body (first line `# Title`)            |
| `update_note`       | Replace a note's body, optionally only if its `revision` still holds |
| `list_note_history` | List the saved copies of a note, newest first                        |
| `read_note_history` | Read the body of one saved copy                                      |
| `restore_note`      | Bring a note back to a saved copy (the current version is saved too) |
| `save_glyph`        | Register or replace a glyph image (png/svg, base64, up to 256 KiB)   |

| Flag / variable                                  | Description                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| `--data-dir` / `MAGICAL_MERCHANT_DATA_DIR`       | Override the data directory (default: the app's own data directory) |
| `--locale` / `MAGICAL_MERCHANT_LOCALE`           | Preferred language for place names, `ja` or `en` (default `en`)     |
| `--allow-write` / `MAGICAL_MERCHANT_ALLOW_WRITE` | Offer the writing tools (off by default)                            |

Timeline times are the recording device's local wall-clock time without a
UTC offset; note times are RFC 3339 with the offset. Place names come from
the app's own geocoding cache — the server never calls a network service.
