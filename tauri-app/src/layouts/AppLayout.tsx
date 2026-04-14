import { createSignal, createMemo } from "solid-js";
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

type Theme = "light" | "dark";

function getInitialTheme(): Theme {
  const saved = localStorage.getItem("theme") as Theme | null;
  if (saved) return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);
}

export default function AppLayout(props: AppLayoutProps) {
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [theme, setTheme] = createSignal<Theme>(getInitialTheme());
  const location = useLocation();

  applyTheme(theme());

  const currentIcon = createMemo(() => MODE_ICONS[location.pathname] ?? "lightning");
  const currentLabel = createMemo(() => MODE_LABELS[location.pathname] ?? "Timeline");

  const toggleTheme = () => {
    const next = theme() === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
  };

  return (
    <div class="app">
      <header class="header">
        <button type="button" onClick={() => setMenuOpen(!menuOpen())} aria-label="Toggle menu">
          <Icon name="list" size={24} />
        </button>
        <button type="button" onClick={toggleTheme} aria-label="Toggle theme">
          <Icon name={theme() === "dark" ? "sun" : "moon"} size={20} />
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
