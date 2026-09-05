import { createSignal } from "solid-js";

export type ShikiTheme = "github-dark-default" | "github-light-default";

export type Theme = "system" | "light" | "dark";

/** 選べるテーマ。Settings がこの順に並べる。 */
export const THEMES: readonly Theme[] = ["system", "light", "dark"] as const;

const STORAGE_KEY = "theme";

function isTheme(value: unknown): value is Theme {
  return value === "system" || value === "light" || value === "dark";
}

function readStoredTheme(): Theme {
  const saved = localStorage.getItem(STORAGE_KEY);
  return isTheme(saved) ? saved : "system";
}

/**
 * 選ばれているテーマ。選ぶのは Settings、system の追従を見張るのは AppLayout
 * と、読み手が二つに分かれたのでモジュールに持たせてある。
 */
const [theme, setTheme] = createSignal<Theme>(readStoredTheme());

export { theme };

function resolveTheme(choice: Theme): "light" | "dark" {
  if (choice === "system") {
    return globalThis.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return choice;
}

/**
 * 実際に当たっているテーマ。CSS 変数で追従できない描画（mermaid は配色を SVG に
 * 焼き込む）は、これを読んで描き直す。
 */
const [resolvedTheme, setResolvedTheme] = createSignal<"light" | "dark">(
  document.documentElement.dataset.theme === "dark" ? "dark" : "light",
);

export { resolvedTheme };

export function applyTheme(choice: Theme): void {
  const resolved = resolveTheme(choice);
  document.documentElement.dataset.theme = resolved;
  setResolvedTheme(resolved);
  localStorage.setItem(STORAGE_KEY, choice);
}

/** 選び直す。Settings 以外から呼ばれることはない。 */
export function chooseTheme(choice: Theme): void {
  setTheme(choice);
  applyTheme(choice);
}

export function getShikiTheme(): ShikiTheme {
  const resolved = document.documentElement.dataset.theme;
  return resolved === "light" ? "github-light-default" : "github-dark-default";
}
