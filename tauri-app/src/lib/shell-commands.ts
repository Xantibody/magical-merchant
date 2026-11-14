/**
 * The actions callable from a key and from the palette. Without a single table, a badge
 * would say "Cmd+N" while the key does nothing. The table is also the shortcut list `?`
 * opens. Its labels follow the language, so it is built on each call and the caller memos it.
 */

import type { IconName } from "../components/Icon";
import { t } from "./i18n";
import { MODE_ICONS, ROUTES } from "./routes";
import type { RoutePath } from "./routes";
import { shortcutLabel } from "./shortcuts";
import type { ShortcutName } from "./shortcuts";

export interface ShellCommand {
  id: string;
  label: string;
  icon: IconName;
  /** Absent for a row reached only from the list (Templates has no key of its own). */
  shortcut?: ShortcutName;
  /** A row that goes somewhere, listed by the empty search field as a place. */
  place?: boolean;
  run: () => void;
}

/** The same rows for the palette and the search field, with the key spelled out. */
export interface CommandRow {
  id: string;
  label: string;
  icon: IconName;
  shortcut: string;
  place?: boolean;
  run: () => void;
}

export interface ShellCommandDeps {
  newNote: () => void;
  /** Closes the palette and navigates. */
  go: (path: RoutePath) => () => void;
  syncNow: () => void;
  toggleSidebar: () => void;
}

export function shellCommands(deps: ShellCommandDeps): ShellCommand[] {
  return [
    {
      id: "new-note",
      label: t().palette.newNote,
      icon: "note-pencil",
      shortcut: "newNote",
      run: deps.newNote,
    },
    {
      id: "go-scrawl",
      label: t().palette.openScrawl,
      icon: MODE_ICONS[ROUTES.SCRAWL],
      shortcut: "scrawl",
      place: true,
      run: deps.go(ROUTES.SCRAWL),
    },
    {
      id: "go-notes",
      label: t().palette.openNotes,
      icon: MODE_ICONS[ROUTES.NOTES],
      shortcut: "notes",
      place: true,
      run: deps.go(ROUTES.NOTES),
    },
    {
      id: "go-codex",
      label: t().palette.openCodex,
      icon: MODE_ICONS[ROUTES.CODEX],
      shortcut: "codex",
      place: true,
      run: deps.go(ROUTES.CODEX),
    },
    {
      id: "go-browse",
      label: t().palette.openBrowse,
      icon: MODE_ICONS[ROUTES.BROWSE],
      shortcut: "browse",
      place: true,
      run: deps.go(ROUTES.BROWSE),
    },
    {
      id: "sync-now",
      label: t().sync.now,
      icon: "cloud-arrow-up",
      shortcut: "syncNow",
      run: deps.syncNow,
    },
    {
      id: "toggle-sidebar",
      label: t().library.toggle,
      icon: "sidebar-simple",
      shortcut: "sidebar",
      run: deps.toggleSidebar,
    },
    {
      id: "go-settings",
      label: t().palette.openSettings,
      icon: MODE_ICONS[ROUTES.SETTINGS],
      shortcut: "settings",
      place: true,
      run: deps.go(ROUTES.SETTINGS),
    },
    // The shelf holds only the places, so Templates is found where Settings is: in the
    // empty search field's places and the palette
    {
      id: "go-templates",
      label: t().palette.openTemplates,
      icon: MODE_ICONS[ROUTES.TEMPLATES],
      place: true,
      run: deps.go(ROUTES.TEMPLATES),
    },
  ];
}

export function commandRows(commands: readonly ShellCommand[]): CommandRow[] {
  return commands.map((command) => ({
    id: command.id,
    label: command.label,
    icon: command.icon,
    shortcut: command.shortcut ? shortcutLabel(command.shortcut) : "",
    place: command.place,
    run: command.run,
  }));
}
