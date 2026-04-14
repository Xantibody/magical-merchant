# Magical Merchant

A minimal note-taking desktop app with Rust core logic and a lightweight UI.

## Design Priorities (in order)

1. **Simple UI** — Minimal chrome, full-screen memo area, hidden actions
2. **Lightweight** — Small bundle, fast startup, no unnecessary dependencies
3. **Stylish** — Clean aesthetics with design tokens (Open Props) and Phosphor Icons

When making UI decisions, always evaluate against these priorities in order.
If a feature adds visual complexity, it must justify itself against simplicity.
If a dependency adds weight, it must justify itself against lightness.

## Tech Stack

| Layer | Technology |
|---|---|
| Core logic | Rust (`core/` crate, framework-independent) |
| Desktop app | TBD (Tauri + React or Dioxus) |
| Styling | Open Props (CSS custom properties) |
| Icons | Phosphor Icons (SVG files) |

## UI Architecture

- **Header**: Toggle button (menu open/close) + current mode icon only
- **Toggle menu**: 3 modes — Timeline / Notes / Tasks
- **Memo area**: Occupies the full screen
- **Actions**: Hidden by default, shown on hover (PC) / flick (mobile)
- **Editing**: Inline Markdown live conversion (Typora-style)
