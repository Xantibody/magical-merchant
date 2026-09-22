import type { IconName } from "../components/Icon";
import type { HitKind } from "./commands";

export const ROUTES = {
  SCRAWL: "/",
  NOTES: "/notes",
  CODEX: "/codex",
  SETTINGS: "/settings",
  TEMPLATES: "/templates",
  /** The screen that narrows by kind / tag / period. Finding by string is ⌘K's job, so it has none */
  BROWSE: "/browse",
} as const;

export type RoutePath = (typeof ROUTES)[keyof typeof ROUTES];

export const MODE_ICONS: Record<RoutePath, IconName> = {
  [ROUTES.SCRAWL]: "scribble-loop",
  [ROUTES.NOTES]: "note-pencil",
  [ROUTES.CODEX]: "book",
  [ROUTES.SETTINGS]: "gear",
  [ROUTES.TEMPLATES]: "file-text",
  [ROUTES.BROWSE]: "funnel",
};

// Template management and Browse do not appear in the tabs. Only the header title reads
// these. The three surfaces are proper nouns, so they are not translated (#255). The
// rail's Browse is the entry to an action, not a tab, so it reads i18n's `browse.title`
export const MODE_LABELS: Record<RoutePath, string> = {
  [ROUTES.SCRAWL]: "Scrawl",
  [ROUTES.NOTES]: "Note",
  [ROUTES.CODEX]: "Codex",
  [ROUTES.SETTINGS]: "Settings",
  [ROUTES.TEMPLATES]: "Templates",
  [ROUTES.BROWSE]: "Browse",
};

/** The surface a record kind lives on. Both the mark and the name are read through here. */
export const HIT_ROUTES: Record<HitKind, RoutePath> = {
  scrawl: ROUTES.SCRAWL,
  note: ROUTES.NOTES,
  codex: ROUTES.CODEX,
};

/**
 * The mark for a record kind, shown on the rows of search, backlinks and Browse. It takes
 * the icon of the surface the kind lives on: spelled out directly, changing a tab's mark
 * would leave the row's mark behind. The kind's name is `MODE_LABELS[HIT_ROUTES[kind]]`
 * for the same reason.
 */
export const HIT_ICONS: Record<HitKind, IconName> = {
  scrawl: MODE_ICONS[HIT_ROUTES.scrawl],
  note: MODE_ICONS[HIT_ROUTES.note],
  codex: MODE_ICONS[HIT_ROUTES.codex],
};
