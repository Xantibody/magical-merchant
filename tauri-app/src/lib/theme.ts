import { createSignal } from "solid-js";
import type { IconName } from "../components/Icon";

export type ShikiTheme = "github-dark-default" | "github-light-default";

export type Theme = "system" | "light" | "dark";

/**
 * 切り替わっていく順。ライトから始めるのは、押した人がまず見たいのが
 * 「今と違う見た目」で、システム追従はその後に戻る場所だから。
 */
const THEMES: readonly Theme[] = ["light", "dark", "system"] as const;

/** アイコンを 1 回押したときの次のテーマ。メニューを出すほどの選択肢ではない。 */
export function nextTheme(current: Theme): Theme {
  const at = THEMES.indexOf(current);
  return THEMES[(at + 1) % THEMES.length];
}

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

/**
 * 実際に当たっているテーマ。CSS 変数で追従できない描画（mermaid は配色を SVG に
 * 焼き込む）は、これを読んで描き直す。
 */
const [resolvedTheme, setResolvedTheme] = createSignal<"light" | "dark">(
  document.documentElement.dataset.theme === "dark" ? "dark" : "light",
);

export { resolvedTheme };

export function applyTheme(theme: Theme): void {
  const resolved = resolveTheme(theme);
  document.documentElement.dataset.theme = resolved;
  setResolvedTheme(resolved);
  localStorage.setItem(STORAGE_KEY, theme);
}

export function getShikiTheme(): ShikiTheme {
  const resolved = document.documentElement.dataset.theme;
  return resolved === "light" ? "github-light-default" : "github-dark-default";
}
