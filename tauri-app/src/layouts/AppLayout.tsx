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

export default function AppLayout(props: AppLayoutProps) {
  const [menuOpen, setMenuOpen] = createSignal(false);
  const location = useLocation();

  const currentIcon = createMemo(
    () => MODE_ICONS[location.pathname] ?? "lightning",
  );

  return (
    <div class="app">
      <header class="header">
        <button
          type="button"
          onClick={() => setMenuOpen(!menuOpen())}
          aria-label="Toggle menu"
        >
          <Icon name="list" size={24} />
        </button>
        <Icon name={currentIcon()} size={20} />
      </header>
      <ToggleMenu isOpen={menuOpen} onClose={() => setMenuOpen(false)} />
      {props.children}
    </div>
  );
}
