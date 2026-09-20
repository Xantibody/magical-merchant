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
 * 現在地の線の位置。レールの上余白 10px + ボタン 36px + 隙間 4px から出る値で、
 * 線 (20px) をボタンの中央に合わせたもの。`styles/rail.css` の実寸と対で動く。
 */
const MARKER_TOP: Partial<Record<RoutePath, number>> = {
  [ROUTES.SCRAWL]: 18,
  [ROUTES.NOTES]: 58,
  [ROUTES.CODEX]: 98,
};

/**
 * 面と全体の操作を縦に並べた 48px の柱。ヘッダの代わり。
 *
 * ヘッダを畳んだのは、横に伸びる帯が「全画面のメモ欄」から高さを奪っていた
 * から。縦に置けば本文の高さは丸ごと残り、面の切替と検索・同期・設定が
 * 同じ距離に並ぶ。現在地は塗りと、左端を滑る 2px の線が言う。
 *
 * 「絞る」は面ではなく操作なので、押しても線は動かない(`MARKER_TOP` に無い)。
 */
export default function Rail(props: { sync: SyncState; onSearch: () => void }): JSX.Element {
  const shell = useShell();
  const location = useLocation();

  const isActive = (path: RoutePath): boolean => location.pathname === path;

  /**
   * 線を最後に置いた高さ。設定のように面でない場所へ移ったときは消すだけに
   * して、位置はそのままにしておく — 戻ったときに線が遠くから飛んでこない。
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
      // 一覧フライアウトはレールの続き。ポインタが柱に乗っているあいだ開く
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

      {/* 面でないところに居るあいだは消す。CSS 側は data-off だけを見る */}
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
