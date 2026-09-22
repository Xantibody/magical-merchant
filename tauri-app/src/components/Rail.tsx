import { createEffect, createSignal, For } from "solid-js";
import type { JSX } from "solid-js";
import { A, useLocation } from "@solidjs/router";
import Icon from "./Icon";
import { useShell } from "../lib/shell";
import { syncIconName } from "../lib/sync";
import type { SyncState } from "../lib/sync";
import { t } from "../lib/i18n";
import { shortcutLabel } from "../lib/shortcuts";
import type { ShortcutName } from "../lib/shortcuts";
import { MODE_ICONS, MODE_LABELS, ROUTES } from "../lib/routes";
import type { RoutePath } from "../lib/routes";

const TABS: { path: RoutePath; shortcut: ShortcutName }[] = [
  { path: ROUTES.SCRAWL, shortcut: "scrawl" },
  { path: ROUTES.NOTES, shortcut: "notes" },
  { path: ROUTES.CODEX, shortcut: "codex" },
];

/**
 * The position of the current-place line. The value comes from the rail's 10px top padding
 * + the 36px button + the 4px gap, with the line (20px) centred on the button. It moves in
 * step with the real measurements in `styles/rail.css`.
 */
const MARKER_TOP: Partial<Record<RoutePath, number>> = {
  [ROUTES.SCRAWL]: 18,
  [ROUTES.NOTES]: 58,
  [ROUTES.CODEX]: 98,
};

/**
 * A 48px column with the surfaces and the app-wide actions stacked vertically. It stands
 * in for the header.
 *
 * The header was folded away because a band running sideways took height from the
 * "full-screen memo area". Placed vertically, the body keeps its whole height, and
 * switching surfaces sits the same distance away as search, sync and settings. The
 * current place is said by the fill and by a 2px line sliding down the left edge.
 *
 * Browse is an action rather than a surface, so pressing it does not move the line (it is
 * not in `MARKER_TOP`).
 */
export default function Rail(props: { sync: SyncState; onSearch: () => void }): JSX.Element {
  const shell = useShell();
  const location = useLocation();

  const isActive = (path: RoutePath): boolean => location.pathname === path;

  /**
   * The height the line was last placed at. Moving somewhere that is not a surface, such
   * as Settings, only hides it and leaves the position alone: coming back, the line does
   * not fly in from far away.
   */
  const [markerTop, setMarkerTop] = createSignal(MARKER_TOP[ROUTES.SCRAWL] ?? 18);
  createEffect(() => {
    const top = MARKER_TOP[location.pathname as RoutePath];
    if (top !== undefined) {
      setMarkerTop(top);
    }
  });
  const onMode = (): boolean => MARKER_TOP[location.pathname as RoutePath] !== undefined;

  return (
    <nav
      class="rail"
      aria-label={t().rail.label}
      // The list flyout is a continuation of the rail. It opens while the pointer is on the column
      onPointerEnter={() => shell.setListHover(true)}
      onPointerLeave={() => shell.setListHover(false)}
    >
      <For each={TABS}>
        {(tab) => (
          <A
            href={tab.path}
            class="rail-button"
            classList={{ "rail-button--active": isActive(tab.path) }}
            title={`${MODE_LABELS[tab.path]} ${shortcutLabel(tab.shortcut)}`}
            aria-label={MODE_LABELS[tab.path]}
            data-hint-key={shortcutLabel(tab.shortcut)}
          >
            <Icon name={MODE_ICONS[tab.path]} size={18} />
          </A>
        )}
      </For>

      {/* Hidden while on somewhere that is not a surface. The CSS looks only at data-off */}
      <span
        class="rail-marker"
        style={{ top: `${markerTop()}px` }}
        data-off={onMode() ? undefined : ""}
        aria-hidden="true"
      />
      <span class="rail-divider" aria-hidden="true" />

      <button
        type="button"
        class="rail-button rail-button--plain"
        title={`${t().header.search} ${shortcutLabel("search")}`}
        aria-label={t().header.search}
        data-hint-key={shortcutLabel("search")}
        onClick={() => props.onSearch()}
      >
        <Icon name="magnifying-glass" size={16} />
      </button>

      <A
        href={ROUTES.BROWSE}
        class="rail-button rail-button--plain"
        classList={{ "rail-button--active": isActive(ROUTES.BROWSE) }}
        title={`${t().browse.title} ${shortcutLabel("browse")}`}
        aria-label={t().browse.title}
        data-hint-key={shortcutLabel("browse")}
      >
        <Icon name={MODE_ICONS[ROUTES.BROWSE]} size={16} />
      </A>

      <button
        type="button"
        class="rail-button rail-button--plain rail-button--foot"
        title={t().header.sync}
        aria-label={t().header.sync}
        aria-expanded={shell.popover() === "sync"}
        data-hint-key={shortcutLabel("syncNow")}
        onClick={(e) => shell.togglePopover("sync", e.currentTarget)}
      >
        <Icon name={syncIconName(props.sync.status())} size={17} />
      </button>

      <A
        href={ROUTES.SETTINGS}
        class="rail-button"
        classList={{ "rail-button--active": isActive(ROUTES.SETTINGS) }}
        title={`${t().header.settings} ${shortcutLabel("settings")}`}
        aria-label={t().header.settings}
        data-hint-key={shortcutLabel("settings")}
      >
        <Icon name="gear" size={17} />
      </A>
    </nav>
  );
}
