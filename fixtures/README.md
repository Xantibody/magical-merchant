# fixtures

Sample data for looking at the app without touching your own notes.
`just sandbox` copies this tree into `.sandbox/` and runs the app against
that copy; nothing here is ever written to.

It is **not** anyone's journal. The text is English, invented, and chosen
to put one of every surface on screen:

| Path                            | What it is there to show                                                 |
| ------------------------------- | ------------------------------------------------------------------------ |
| `data/scrawl/2026-08-01.md`     | a day written from two devices, with tags, a location and a widget entry |
| `data/scrawl/2026-08-03.md`     | a single-device day, one entry of which was promoted into a Note         |
| `data/notes/20260801_093000.md` | a plain Note with tags and a `[[link]]` to another                       |
| `data/notes/20260802_141500.md` | a code block (Shiki) and a Mermaid figure                                |
| `data/notes/20260803_100000.md` | `view: preview` — the read-only Note                                     |
| `data/notes/20260804_170000.md` | `view: mindmap` — the map laid alongside                                 |
| `data/notes/20260805_080000.md` | `origin:` — grown out of a Scrawl entry, written by the widget           |
| `data/notes/20260806_120000.md` | `template:` — created from the `daily` template                          |
| `data/codex/20260701_090000.md` | a Codex whose draft has moved on from its latest version                 |
| `data/codex/20260701_090000/`   | three committed versions, one of them with a message                     |
| `data/templates/`               | `{{date}}`, `{{weekday}}`, `{{prev}}` and a template with none of them   |

`core/tests/fixtures.rs` reads every file here through the core on each CI
run, so a format change cannot quietly leave this tree behind.

Dates are fixed on purpose: the same tree gives the same screen on every
machine. That is also why everything lands under "earlier" rather than
"today" — if you want entries dated now, write them in the sandbox.
