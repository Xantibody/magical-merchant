import type { IconName } from "../components/Icon";

export const ROUTES = {
  TIMELINE: "/",
  NOTES: "/notes",
  TASKS: "/tasks",
  SETTINGS: "/settings",
} as const;

export const MODE_ICONS: Record<string, IconName> = {
  [ROUTES.TIMELINE]: "lightning",
  [ROUTES.NOTES]: "note-pencil",
  [ROUTES.TASKS]: "check-square",
  [ROUTES.SETTINGS]: "gear",
};

export const MODE_LABELS: Record<string, string> = {
  [ROUTES.TIMELINE]: "Timeline",
  [ROUTES.NOTES]: "Notes",
  [ROUTES.TASKS]: "Tasks",
  [ROUTES.SETTINGS]: "Settings",
};
