# Feature Tour

A walkthrough of every surface in Magical Merchant. Screenshots are taken
from the browser verification harness with fixture data.

## Timeline — a journal that captures first

The Timeline is a single-column, day-grouped journal. The capture bar at the
bottom is always ready: type, send, and the entry lands on today with a
timestamp. Entries record the device context they were written in (device,
network, battery, and a place name resolved from the coordinate), tags typed
as `#tag` become filter chips, and the calendar button jumps to any recorded
day.

![Timeline](images/timeline.png)

At the top, a **weekly digest** appears once per week: how many entries on how
many days, the most used tags (tap to filter), and — when that day has
entries — a jump to _one year ago today_. Dismissing it hides it for the rest
of the week, per device.

### Mobile

The same journal on a phone. Bottom tabs switch between Timeline, Notes and
Settings; the capture bar floats above the keyboard.

![Mobile timeline](images/mobile-timeline.png)

### Promote an entry into a note

When a quick capture grows into something bigger, promote it: hover an entry
(PC) or long-press it (touch) and choose ノートにする. A new note opens ready
to write, carrying the entry text and tags. The note's frontmatter records the
origin entry, and the timeline shows a chip (📄 title →) on that day linking
to the note — derived on every render, so reordering or deleting entries never
breaks the link.

## Notes — a Typora-style Markdown workspace

Notes are plain Markdown files. The list pane groups them by date; the detail
pane shows a rendered preview with a **title field** above it. The title is
the note's leading `# heading` — there is no separate title in the
frontmatter, so the file stays readable in any Markdown tool and the heading
can never drift from the title. Press Enter in the field to drop into the
body. **Tap anywhere in the preview to start
editing** — the caret lands on the character you tapped. Saving is automatic
(debounced), and the first content-changing save of a session keeps the
pre-edit body on the device, so ノート情報 → 編集前に戻す can undo an
accidental edit — press it again to swap back.

The ノート情報 panel is also where a note's records live: the creation time
(editable), the tags, the device context it was captured on, and — once the
body has been rewritten at least once — the **update time**. Creation time is
pinned to the filename order, so the update time is the only place a rewrite
shows up. Changing metadata or the view mode is not a rewrite and leaves it
alone.

![Editor with note links](images/editor-links.png)

Code blocks are highlighted with Shiki, ` ```mermaid ` fences render as
diagrams, and a per-note **mindmap view** (frontmatter `view: mindmap`) turns
the heading/list structure into a markmap:

![Mindmap view](images/mindmap.png)

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

## Search palette

`⌘K` opens the palette. Before you type anything it offers entry points:
recent notes, today/yesterday (only when they have entries), and your most
used tags. Search results highlight the matched text in a context snippet, and
selecting a hit lands exactly — a note opens that note, a timeline hit scrolls
to that day.

![Command palette](images/palette.png)

## Language

The interface speaks Japanese or English. It follows the system language on
first launch and can be pinned either way in Settings → LANGUAGE; the choice
takes effect immediately, without a restart. Only the interface changes —
what you wrote stays exactly as you wrote it, and so do your tags.

## Sync (optional)

A Cloudflare Worker + R2 backend syncs the Markdown files across devices.
Conflicts keep the local copy and preserve the loser as a
`.sync-conflict-<timestamp>.md` next to the note. See [sync.md](sync.md) for
deployment and the change-detection protocol.

## Android widgets

Three home-screen widgets ship with the APK: a Timeline capture bar (writes
through JNI without launching the app), a "new note" bar, and a recent notes
list that deep-links into the app.

## AI access (MCP)

`mcp-cli` exposes the same core as read-only
[Model Context Protocol](https://modelcontextprotocol.io/) tools for AI
assistants:

```sh
magical_merchant_mcp_cli --data-dir /path/to/data
```

| Tool                  | Description                                  |
| --------------------- | -------------------------------------------- |
| `list_notes`          | List all notes with tags and a short preview |
| `read_note`           | Read a note's full Markdown source           |
| `search`              | Search notes and timeline entries            |
| `list_timeline_dates` | List the dates that have timeline entries    |
| `read_timeline`       | Read all timeline entries for a single day   |

> [!NOTE]
> The data directory can also be set with the `MAGICAL_MERCHANT_DATA_DIR`
> environment variable.
