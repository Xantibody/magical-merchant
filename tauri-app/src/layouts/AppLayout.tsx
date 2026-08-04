import { createSignal, createEffect, onCleanup, onMount, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useLocation, useNavigate, A } from "@solidjs/router";
import Icon from "../components/Icon";
import CommandPalette from "../components/CommandPalette";
import SyncPopover from "../components/SyncPopover";
import ThemeMenu from "../components/ThemeMenu";
import UndoToast from "../components/UndoToast";
import { ShellProvider, useShell } from "../lib/shell";
import { createSyncState, syncIconName } from "../lib/sync";
import { applyTheme, readStoredTheme, THEME_ICONS } from "../lib/theme";
import type { Theme } from "../lib/theme";
import { MODE_ICONS, MODE_LABELS, ROUTES } from "../lib/routes";
import type { RoutePath } from "../lib/routes";
import { typedInvoke } from "../lib/commands";

const TABS: RoutePath[] = [ROUTES.TIMELINE, ROUTES.NOTES];
const BOTTOM_TABS: RoutePath[] = [ROUTES.TIMELINE, ROUTES.NOTES, ROUTES.SETTINGS];

function isMetaK(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
}

function isMetaN(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n";
}

function Chrome(props: { children?: JSX.Element }): JSX.Element {
  const shell = useShell();
  const location = useLocation();
  const navigate = useNavigate();

  const [theme, setTheme] = createSignal<Theme>(readStoredTheme());
  const sync = createSyncState(() => shell.refreshData());

  applyTheme(theme());
  createEffect(() => applyTheme(theme()));

  const media = globalThis.matchMedia("(prefers-color-scheme: dark)");
  const onSchemeChange = (): void => {
    if (theme() === "system") {
      applyTheme("system");
    }
  };
  media.addEventListener("change", onSchemeChange);
  onCleanup(() => media.removeEventListener("change", onSchemeChange));

  // エラーは黙って消さず、同期ポップオーバーを開いて知らせる
  createEffect(() => {
    if (sync.alertVersion() > 0) {
      shell.togglePopover("sync");
    }
  });

  const newNote = (): void => {
    shell.closePalette();
    void (async () => {
      await typedInvoke("create_draft", {
        body: "",
        tags: [],
        latitude: null,
        longitude: null,
      });
      shell.refreshData();
      navigate(ROUTES.NOTES);
    })();
  };

  onMount(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (isMetaK(e)) {
        e.preventDefault();
        shell.openPalette();
        return;
      }
      if (isMetaN(e)) {
        e.preventDefault();
        newNote();
        return;
      }
      if (e.key === "Escape") {
        shell.closePopovers();
        shell.closePalette();
      }
    };
    globalThis.addEventListener("keydown", onKeyDown);
    onCleanup(() => globalThis.removeEventListener("keydown", onKeyDown));

    // ポップオーバーの外側をクリックしたら閉じる。ルート要素の onClick では
    // ポータルや overlay の外に出たクリックを取りこぼす
    const onPointerDown = (e: MouseEvent): void => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target?.closest(".popover, .header-action, .calendar-button")) {
        shell.closePopovers();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    onCleanup(() => document.removeEventListener("pointerdown", onPointerDown));
  });

  const isActive = (path: RoutePath): boolean => location.pathname === path;

  return (
    <div class="app">
      <header class="header">
        <nav class="header-tabs">
          <For each={TABS}>
            {(path) => (
              <A
                href={path}
                class="header-tab"
                classList={{ "header-tab--active": isActive(path) }}
              >
                <Icon name={MODE_ICONS[path]} size={16} />
                {MODE_LABELS[path]}
              </A>
            )}
          </For>
        </nav>

        <span class="header-title">
          {MODE_LABELS[location.pathname as RoutePath] ?? "Timeline"}
        </span>

        <button type="button" class="search-field" onClick={() => shell.openPalette()}>
          <Icon name="magnifying-glass" size={15} />
          <span class="search-field-label">検索・コマンド…</span>
          <span class="key-badge">⌘K</span>
        </button>

        <div class="header-actions">
          {/* 幅が狭いと検索フィールドが隠れるので、代わりの入口を用意する */}
          <button
            type="button"
            class="icon-button header-action header-action--search"
            title="検索"
            aria-label="検索"
            onClick={() => shell.openPalette()}
          >
            <Icon name="magnifying-glass" size={18} />
          </button>
          <button
            type="button"
            class="icon-button header-action"
            title="同期"
            aria-label="同期"
            aria-expanded={shell.popover() === "sync"}
            onClick={() => shell.togglePopover("sync")}
          >
            <Icon name={syncIconName(sync.status())} size={18} />
          </button>
          <button
            type="button"
            class="icon-button header-action"
            title="テーマ"
            aria-label="テーマ"
            aria-expanded={shell.popover() === "theme"}
            onClick={() => shell.togglePopover("theme")}
          >
            <Icon name={THEME_ICONS[theme()]} size={18} />
          </button>
          <A
            href={ROUTES.SETTINGS}
            class="icon-button header-action header-action--settings"
            title="Settings"
          >
            <Icon name="gear" size={18} />
          </A>
        </div>

        <Show when={shell.popover() === "sync"}>
          <div class="popover-anchor popover-anchor--sync">
            <SyncPopover sync={sync} onClose={() => shell.closePopovers()} />
          </div>
        </Show>
        <Show when={shell.popover() === "theme"}>
          <div class="popover-anchor popover-anchor--theme">
            <ThemeMenu
              theme={theme}
              onSelect={(next) => {
                setTheme(next);
                shell.closePopovers();
              }}
            />
          </div>
        </Show>
      </header>

      <main class="app-main">{props.children}</main>

      <nav class="bottom-tabs">
        <For each={BOTTOM_TABS}>
          {(path) => (
            <A href={path} class="bottom-tab" classList={{ "bottom-tab--active": isActive(path) }}>
              <Icon name={MODE_ICONS[path]} size={22} />
              {MODE_LABELS[path]}
            </A>
          )}
        </For>
      </nav>

      <UndoToast />

      <Show when={shell.paletteOpen()}>
        <CommandPalette
          commands={[
            {
              id: "new-note",
              label: "新規ノート",
              icon: "note-pencil",
              shortcut: "⌘N",
              run: newNote,
            },
            {
              id: "sync-now",
              label: "今すぐ同期",
              icon: "cloud-arrow-up",
              run: () => {
                shell.closePalette();
                void sync.syncNow();
              },
            },
          ]}
          onSelectHit={(hit) => {
            shell.closePalette();
            navigate(hit.kind === "note" ? ROUTES.NOTES : ROUTES.TIMELINE);
          }}
          onClose={() => shell.closePalette()}
        />
      </Show>
    </div>
  );
}

export default function AppLayout(props: { children?: JSX.Element }): JSX.Element {
  return (
    <ShellProvider>
      <Chrome>{props.children}</Chrome>
    </ShellProvider>
  );
}
