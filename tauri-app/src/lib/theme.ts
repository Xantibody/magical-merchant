import type { IconName } from "../components/Icon";

export type ShikiTheme = "github-dark-default" | "github-light-default";

export type Theme = "system" | "light" | "dark";

export const THEMES: readonly Theme[] = ["system", "light", "dark"] as const;

export const THEME_LABELS: Record<Theme, string> = {
  system: "システム",
  light: "ライト",
  dark: "ダーク",
};

export const THEME_ICONS: Record<Theme, IconName> = {
  system: "circle-half",
  light: "sun",
  dark: "moon",
};

const STORAGE_KEY = "theme";

function isTheme(value: unknown): value is Theme {
  return value === "system" || value === "light" || value === "dark";
}

export function readStoredTheme(): Theme {
  const saved = localStorage.getItem(STORAGE_KEY);
  return isTheme(saved) ? saved : "system";
}

function resolveTheme(theme: Theme): "light" | "dark" {
  if (theme === "system") {
    return globalThis.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return theme;
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = resolveTheme(theme);
  localStorage.setItem(STORAGE_KEY, theme);
}

export function getShikiTheme(): ShikiTheme {
  const resolved = document.documentElement.dataset.theme;
  return resolved === "light" ? "github-light-default" : "github-dark-default";
}
