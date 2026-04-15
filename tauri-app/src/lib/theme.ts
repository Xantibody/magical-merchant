export type ShikiTheme = "github-dark-default" | "github-light-default";

export function getShikiTheme(): ShikiTheme {
  const resolved = document.documentElement.getAttribute("data-theme");
  return resolved === "light" ? "github-light-default" : "github-dark-default";
}
