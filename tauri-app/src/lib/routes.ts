import type { IconName } from "../components/Icon";

export const ROUTES = {
  TIMELINE: "/",
  NOTES: "/notes",
  SETTINGS: "/settings",
} as const;

export type RoutePath = (typeof ROUTES)[keyof typeof ROUTES];

export const MODE_ICONS: Record<RoutePath, IconName> = {
  [ROUTES.TIMELINE]: "lightning",
  [ROUTES.NOTES]: "note-pencil",
  [ROUTES.SETTINGS]: "gear",
};

export const MODE_LABELS: Record<RoutePath, string> = {
  [ROUTES.TIMELINE]: "Timeline",
  [ROUTES.NOTES]: "Notes",
  [ROUTES.SETTINGS]: "Settings",
};
