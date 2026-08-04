import { For, Show } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import Icon from "./Icon";
import { THEMES, THEME_ICONS, THEME_LABELS } from "../lib/theme";
import type { Theme } from "../lib/theme";

interface ThemeMenuProps {
  theme: Accessor<Theme>;
  onSelect: (theme: Theme) => void;
}

export default function ThemeMenu(props: ThemeMenuProps): JSX.Element {
  return (
    <div class="popover theme-menu" role="menu">
      <For each={THEMES}>
        {(theme) => (
          <button
            type="button"
            role="menuitemradio"
            aria-checked={props.theme() === theme}
            class="theme-menu-item"
            onClick={() => props.onSelect(theme)}
          >
            <Icon name={THEME_ICONS[theme]} size={16} />
            {THEME_LABELS[theme]}
            <Show when={props.theme() === theme}>
              <span class="theme-menu-check">
                <Icon name="check" size={14} />
              </span>
            </Show>
          </button>
        )}
      </For>
    </div>
  );
}
