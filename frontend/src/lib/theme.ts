import { createSignal } from "solid-js";

export type ShikiTheme = "github-dark-default" | "github-light-default";

export type Theme = "system" | "light" | "dark";

/** The themes that can be chosen. Settings lays them out in this order. */
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
 * The theme that is chosen. Settings does the choosing and AppLayout watches the system
 * setting it follows, so with two readers it is held in the module.
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
 * The theme actually in effect. Drawing that cannot follow through CSS variables (mermaid
 * bakes the palette into the SVG) reads this and redraws.
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

/** Choose again. Nothing but Settings calls this. */
export function chooseTheme(choice: Theme): void {
  setTheme(choice);
  applyTheme(choice);
}

export function getShikiTheme(): ShikiTheme {
  const resolved = document.documentElement.dataset.theme;
  return resolved === "light" ? "github-light-default" : "github-dark-default";
}
