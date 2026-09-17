import type { IconName } from "../components/Icon";
import type { HitKind } from "./commands";

export const ROUTES = {
  TIMELINE: "/",
  NOTES: "/notes",
  CODEX: "/codex",
  SETTINGS: "/settings",
  TEMPLATES: "/templates",
} as const;

export type RoutePath = (typeof ROUTES)[keyof typeof ROUTES];

export const MODE_ICONS: Record<RoutePath, IconName> = {
  [ROUTES.TIMELINE]: "scribble-loop",
  [ROUTES.NOTES]: "note-pencil",
  [ROUTES.CODEX]: "book",
  [ROUTES.SETTINGS]: "gear",
  [ROUTES.TEMPLATES]: "file-text",
};

// テンプレート管理は Settings の下にある画面で、タブには出ない。
// ヘッダの題だけがここを引く
export const MODE_LABELS: Record<RoutePath, string> = {
  [ROUTES.TIMELINE]: "Scrawl",
  [ROUTES.NOTES]: "Note",
  [ROUTES.CODEX]: "Codex",
  [ROUTES.SETTINGS]: "Settings",
  [ROUTES.TEMPLATES]: "Templates",
};

/** 検索・バックリンクの行に出す、記録の種類の印。面のアイコンと揃える。 */
export const HIT_ICONS: Record<HitKind, IconName> = {
  timeline: "lightning",
  note: "file-text",
  codex: MODE_ICONS[ROUTES.CODEX],
};
