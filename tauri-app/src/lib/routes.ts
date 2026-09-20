import type { IconName } from "../components/Icon";
import type { HitKind } from "./commands";

export const ROUTES = {
  SCRAWL: "/",
  NOTES: "/notes",
  CODEX: "/codex",
  SETTINGS: "/settings",
  TEMPLATES: "/templates",
  /** 種類 / タグ / 期間で絞る画面。文字列で探すのは ⌘K の仕事なので持たない */
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

// テンプレート管理と絞る画面はタブに出ない。ヘッダの題だけがここを引く。
// 3 面は固有名詞なので訳さない(#255)。レールの「絞る」はタブではなく操作の
// 入口なので、そちらは i18n の `browse.title` を読む
export const MODE_LABELS: Record<RoutePath, string> = {
  [ROUTES.SCRAWL]: "Scrawl",
  [ROUTES.NOTES]: "Note",
  [ROUTES.CODEX]: "Codex",
  [ROUTES.SETTINGS]: "Settings",
  [ROUTES.TEMPLATES]: "Templates",
  [ROUTES.BROWSE]: "Browse",
};

/** 記録の種類が住んでいる面。印と名前はどちらもここを経由して引く。 */
export const HIT_ROUTES: Record<HitKind, RoutePath> = {
  scrawl: ROUTES.SCRAWL,
  note: ROUTES.NOTES,
  codex: ROUTES.CODEX,
};

/**
 * 検索・バックリンク・絞る画面の行に出す、記録の種類の印。住んでいる面の
 * アイコンをそのまま引く — 直に綴ると、タブの印を変えたときに行の印だけが
 * 取り残される。種類の名前も同じ理由で `MODE_LABELS[HIT_ROUTES[kind]]`。
 */
export const HIT_ICONS: Record<HitKind, IconName> = {
  scrawl: MODE_ICONS[HIT_ROUTES.scrawl],
  note: MODE_ICONS[HIT_ROUTES.note],
  codex: MODE_ICONS[HIT_ROUTES.codex],
};
