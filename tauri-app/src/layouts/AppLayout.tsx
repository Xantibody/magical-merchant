import { createSignal, createEffect, onCleanup } from "solid-js";
import { useLocation } from "@solidjs/router";
import Icon, { type IconName } from "../components/Icon";
import ToggleMenu from "../components/ToggleMenu";

interface AppLayoutProps {
  children?: any;
}

const MODE_ICONS: Record<string, IconName> = {
  "/": "lightning",
  "/notes": "note-pencil",
  "/tasks": "check-square",
};

const MODE_LABELS: Record<string, string> = {
  "/": "Timeline",
  "/notes": "Notes",
  "/tasks": "Tasks",
};

type Theme = "light" | "dark" | "system";

function getInitialTheme(): Theme {
  const saved = localStorage.getItem("theme") as Theme | null;
  if (saved === "light" || saved === "dark" || saved === "system") return saved;
  return "system";
}

function getResolvedTheme(theme: Theme): "light" | "dark" {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return theme;
}

function applyTheme(theme: Theme) {
  const resolved = getResolvedTheme(theme);
  document.documentElement.setAttribute("data-theme", resolved);
  localStorage.setItem("theme", theme);
}

export default function AppLayout(props: AppLayoutProps) {
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [theme, setTheme] = createSignal<Theme>(getInitialTheme());
  const location = useLocation();

  applyTheme(theme());

  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const handleMediaChange = () => {
    if (theme() === "system") {
      applyTheme("system");
    }
  };
  mediaQuery.addEventListener("change", handleMediaChange);
  onCleanup(() => mediaQuery.removeEventListener("change", handleMediaChange));

  createEffect(() => {
    applyTheme(theme());
  });

  const currentIcon = () => MODE_ICONS[location.pathname] ?? "lightning";
  const currentLabel = () => MODE_LABELS[location.pathname] ?? "Timeline";

  const cycleTheme = () => {
    const order: Theme[] = ["system", "light", "dark"];
    const idx = order.indexOf(theme());
    const next = order[(idx + 1) % order.length];
    setTheme(next);
  };

  const themeIcon = () => {
    const t = theme();
    if (t === "system") return "lightning" as IconName;
    return t === "dark" ? ("sun" as IconName) : ("moon" as IconName);
  };

  return (
    <div class="app">
      <header class="header">
        <button type="button" onClick={() => setMenuOpen(!menuOpen())} aria-label="Toggle menu">
          <Icon name="list" size={24} />
        </button>
        <button type="button" onClick={cycleTheme} aria-label="Toggle theme">
          <Icon name={themeIcon()} size={20} />
        </button>
      </header>
      <ToggleMenu isOpen={menuOpen} onClose={() => setMenuOpen(false)} />
      {props.children}
      <div class="mode-indicator">
        <Icon name={currentIcon()} size={14} />
        <span>{currentLabel()}</span>
      </div>
    </div>
  );
}
