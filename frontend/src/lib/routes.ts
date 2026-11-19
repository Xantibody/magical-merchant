import type { IconName } from "../components/Icon";
import type { HitKind } from "./commands";
import { t } from "./i18n";

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

/** The three pages of Settings. The order is the nav order. */
export type SettingsPage = "general" | "records" | "sync";
export const SETTINGS_PAGES: readonly SettingsPage[] = ["general", "records", "sync"] as const;

/** The query key Settings reads to open on a page. One place, so the link and the reader agree */
export const SETTINGS_PAGE_PARAM = "page";

/** The route to Settings opened on one page, e.g. `/settings?page=sync`. */
export function settingsPage(id: SettingsPage): string {
  return `${ROUTES.SETTINGS}?${SETTINGS_PAGE_PARAM}=${id}`;
}

export const MODE_ICONS: Record<RoutePath, IconName> = {
  [ROUTES.SCRAWL]: "scribble-loop",
  [ROUTES.NOTES]: "note-pencil",
  [ROUTES.CODEX]: "book",
  [ROUTES.SETTINGS]: "gear",
  [ROUTES.TEMPLATES]: "file-text",
  [ROUTES.BROWSE]: "funnel",
};

/** The three surfaces, the only screens whose name is a proper noun. */
type SurfaceRoute = typeof ROUTES.SCRAWL | typeof ROUTES.NOTES | typeof ROUTES.CODEX;

// The three surfaces are proper nouns, so they are not translated (#255). Every other
// screen is a page with a title in the string table; `routeLabel` names those
export const MODE_LABELS: Record<SurfaceRoute, string> = {
  [ROUTES.SCRAWL]: "Scrawl",
  [ROUTES.NOTES]: "Note",
  [ROUTES.CODEX]: "Codex",
};

/**
 * The name of the screen at `path`, for a phone's folded bar and the pages' large names. A
 * surface keeps its proper noun; any other page takes the title its own heading reads, so the
 * bar and the page say the same word. Call it inside JSX so switching the language redraws. A
 * path no route knows reads as Scrawl.
 */
export function routeLabel(path: string): string {
  switch (path) {
    case ROUTES.SETTINGS: {
      return t().settings.title;
    }
    case ROUTES.TEMPLATES: {
      return t().templates.title;
    }
    case ROUTES.BROWSE: {
      return t().browse.title;
    }
    case ROUTES.NOTES: {
      return MODE_LABELS[ROUTES.NOTES];
    }
    case ROUTES.CODEX: {
      return MODE_LABELS[ROUTES.CODEX];
    }
    default: {
      return MODE_LABELS[ROUTES.SCRAWL];
    }
  }
}

/** The surface a record kind lives on. Both the mark and the name are read through here. */
export const HIT_ROUTES: Record<HitKind, SurfaceRoute> = {
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
