import { createSignal } from "solid-js";
import Icon from "../components/Icon";
import ToggleMenu from "../components/ToggleMenu";

interface AppLayoutProps {
  children?: any;
}

export default function AppLayout(props: AppLayoutProps) {
  const [menuOpen, setMenuOpen] = createSignal(false);

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
      </header>
      <ToggleMenu isOpen={menuOpen} onClose={() => setMenuOpen(false)} />
      {props.children}
    </div>
  );
}
