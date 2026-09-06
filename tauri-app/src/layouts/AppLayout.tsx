import { createEffect, createMemo, onCleanup, onMount, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useLocation, useNavigate, A } from "@solidjs/router";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Icon from "../components/Icon";
import type { IconName } from "../components/Icon";
import CommandPalette from "../components/CommandPalette";
import SyncPopover from "../components/SyncPopover";
import UndoToast from "../components/UndoToast";
import FirstRunCard from "../components/FirstRunCard";
import { ShellProvider, useShell } from "../lib/shell";
import { createSyncState, syncIconName } from "../lib/sync";
import { applyTheme, theme } from "../lib/theme";
import { locale, t } from "../lib/i18n";
import { createHints } from "../lib/hints";
import {
  isTypingTarget,
  matchesShortcut,
  modifierLabel,
  shortcutLabel,
  SHORTCUT_LIST_KEY,
} from "../lib/shortcuts";
import type { ShortcutName } from "../lib/shortcuts";
import { MODE_ICONS, MODE_LABELS, ROUTES } from "../lib/routes";
import type { RoutePath } from "../lib/routes";
import { typedInvoke } from "../lib/commands";
import { paletteScopeAt } from "../lib/search-scope";
import { firstWidgetAction } from "../lib/widget-actions";
import type { WidgetAction } from "../lib/widget-actions";
import { getDeviceSignals, warmLocation } from "../lib/client-context";
import { applyStartFullscreen } from "../lib/fullscreen";
import { loadGlyphs } from "../lib/glyphs";

const TABS: { path: RoutePath; shortcut: ShortcutName }[] = [
  { path: ROUTES.TIMELINE, shortcut: "timeline" },
  { path: ROUTES.NOTES, shortcut: "notes" },
];
const BOTTOM_TABS: RoutePath[] = [ROUTES.TIMELINE, ROUTES.NOTES, ROUTES.SETTINGS];

/** system を選んでいる人の画面は、端末の設定が変わった瞬間に切り替わる。 */
function onSchemeChange(): void {
  if (theme() === "system") {
    applyTheme("system");
  }
}

/** キーとパレットの両方から呼べる操作。 */
interface ShellCommand {
  id: string;
  label: string;
  icon: IconName;
  shortcut: ShortcutName;
  run: () => void;
}

function Chrome(props: { children?: JSX.Element }): JSX.Element {
  const shell = useShell();
  const location = useLocation();
  const navigate = useNavigate();

  const sync = createSyncState(() => shell.refreshData());
  const hints = createHints();

  // 選ぶのは Settings。ここは覚えている選択を起動時に当て直すだけ
  applyTheme(theme());

  // 札は DOM を増やさず、擬似要素として描く。html に印を付ければ全画面に効く
  createEffect(() => {
    if (hints.visible()) {
      document.documentElement.dataset.hints = "";
    } else {
      delete document.documentElement.dataset.hints;
    }
  });

  const media = globalThis.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", onSchemeChange);
  onCleanup(() => media.removeEventListener("change", onSchemeChange));

  // エラーは黙って消さず、同期ポップオーバーを開いて知らせる
  createEffect(() => {
    if (sync.alertVersion() > 0) {
      shell.togglePopover("sync");
    }
  });

  const isActive = (path: RoutePath): boolean => location.pathname === path;

  /**
   * Timeline でタグを選んで絞っているなら、その中を探す。全体を探したければ
   * パレットのチップを外せばよく、逆(絞り込みを後から思い出す)は難しい
   */
  const openSearch = (): void => {
    shell.openPalette(paletteScopeAt(location.pathname, shell.timelineTag()));
  };

  // グリフの登録表は起動時に 1 回と、データが入れ替わった合図(同期の
  // 完了など)のたびに読み直す。本文のどこにも画像は書かれていないので、
  // 表が無いと `:236p:` は文字のまま出る
  createEffect(() => {
    shell.dataVersion();
    void loadGlyphs();
  });

  const newNote = (): void => {
    shell.closePalette();
    void (async () => {
      await typedInvoke("create_draft", {
        body: "",
        tags: [],
        client: await getDeviceSignals(),
      });
      shell.refreshData();
      navigate(ROUTES.NOTES);
    })();
  };

  const go = (path: RoutePath) => (): void => {
    shell.closePalette();
    navigate(path);
  };

  /**
   * キーからも、パレットからも呼べる操作。表を 1 つにしておかないと、
   * ヘッダーの札に「⌘N」と出ているのにキーが効かない、という食い違いが出る。
   * ここが `?` で開くショートカット一覧そのものでもある
   */
  const commands = createMemo<ShellCommand[]>(() => [
    {
      id: "new-note",
      label: t().palette.newNote,
      icon: "note-pencil",
      shortcut: "newNote",
      run: newNote,
    },
    {
      id: "go-timeline",
      label: t().palette.openTimeline,
      icon: MODE_ICONS[ROUTES.TIMELINE],
      shortcut: "timeline",
      run: go(ROUTES.TIMELINE),
    },
    {
      id: "go-notes",
      label: t().palette.openNotes,
      icon: MODE_ICONS[ROUTES.NOTES],
      shortcut: "notes",
      run: go(ROUTES.NOTES),
    },
    {
      id: "sync-now",
      label: t().sync.now,
      icon: "cloud-arrow-up",
      shortcut: "syncNow",
      run: () => {
        shell.closePalette();
        void sync.syncNow();
      },
    },
    {
      id: "go-settings",
      label: t().palette.openSettings,
      icon: MODE_ICONS[ROUTES.SETTINGS],
      shortcut: "settings",
      run: go(ROUTES.SETTINGS),
    },
  ]);

  /**
   * ウィジェットのテンプレボタン。同じテンプレの今日のぶんが既にあれば
   * core が作らずにそれを返すので、ここは開くだけでいい。
   */
  const openFromTemplate = (name: string): void => {
    shell.closePalette();
    void (async () => {
      try {
        const created = await typedInvoke("create_from_template", {
          filename: `${name}.md`,
          locale: locale(),
          client: await getDeviceSignals(),
        });
        shell.refreshData();
        const filename = created.path.split("/").at(-1);
        navigate(filename ? `${ROUTES.NOTES}?file=${encodeURIComponent(filename)}` : ROUTES.NOTES);
      } catch {
        // 消したテンプレを指したままのウィジェットが残っていることがある。
        // 押しても何も起きないより、一覧を開いて理由を出す
        navigate(ROUTES.NOTES);
        shell.showToast(t().templates.createFailed);
      }
    })();
  };

  const runWidgetAction = (action: WidgetAction): void => {
    if (action.name === "new-note") {
      newNote();
      return;
    }
    if (action.name === "template" && action.template) {
      openFromTemplate(action.template);
      return;
    }
    // ボタンが 1 つも無いウィジェットと、そのヘッダの行き先
    if (action.name === "templates") {
      navigate(ROUTES.TEMPLATES);
      return;
    }
    // ?file= はルーターに預ける。Workspace の選択状態を外から触れるように
    // 引き上げるより、開きたいノートを URL に持たせるほうが素直
    if (action.name === "note" && action.file) {
      navigate(`${ROUTES.NOTES}?file=${encodeURIComponent(action.file)}`);
    }
  };

  onMount(() => {
    // 最初の記録が測位を待たされないよう、許可済みなら今のうちに測り始める
    warmLocation();

    // 設定画面は遅延読み込みなので、起動時の窓の姿はここで決める
    void applyStartFullscreen();

    // ウィジェットのタップはたいていアプリを冷えた状態から起こす。onOpenUrl は
    // 購読してからのぶんしか来ないので、起動時の URL は getCurrent で拾う。
    let unlistenWidget: UnlistenFn | undefined;
    void (async () => {
      unlistenWidget = await onOpenUrl((urls) => {
        const action = firstWidgetAction(urls);
        if (action) {
          runWidgetAction(action);
        }
      });
      const launched = firstWidgetAction((await getCurrent()) ?? []);
      if (launched) {
        runWidgetAction(launched);
      }
    })();
    onCleanup(() => unlistenWidget?.());

    const onKeyDown = (e: KeyboardEvent): void => {
      hints.keyDown(e);

      if (matchesShortcut(e, "search")) {
        e.preventDefault();
        openSearch();
        return;
      }
      for (const command of commands()) {
        if (matchesShortcut(e, command.shortcut)) {
          e.preventDefault();
          command.run();
          return;
        }
      }
      // 一覧はパレットのコマンド節そのもの。別の画面を作るほどの中身がない。
      // 修飾キーを伴わないキーなので、書いている最中は文字として通す
      if (e.key === SHORTCUT_LIST_KEY && !shell.paletteOpen() && !isTypingTarget(e.target)) {
        e.preventDefault();
        openSearch();
        return;
      }
      if (e.key === "Escape") {
        shell.closePopovers();
        shell.closePalette();
      }
    };
    globalThis.addEventListener("keydown", onKeyDown);
    onCleanup(() => globalThis.removeEventListener("keydown", onKeyDown));

    // 離した瞬間に消す。窓から出た(⌘Tab)ときは keyup が来ないので blur も見る
    const onKeyUp = (e: KeyboardEvent): void => hints.keyUp(e);
    const onBlur = (): void => hints.hide();
    globalThis.addEventListener("keyup", onKeyUp);
    globalThis.addEventListener("blur", onBlur);
    onCleanup(() => {
      globalThis.removeEventListener("keyup", onKeyUp);
      globalThis.removeEventListener("blur", onBlur);
    });

    // ポップオーバーの外側をクリックしたら閉じる。ルート要素の onClick では
    // ポータルや overlay の外に出たクリックを取りこぼす
    const onPointerDown = (e: MouseEvent): void => {
      const target = e.target instanceof Element ? e.target : null;
      if (
        !target?.closest(".popover, .header-action, .calendar-button, .note-menu-button, .new-note")
      ) {
        shell.closePopovers();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    onCleanup(() => document.removeEventListener("pointerdown", onPointerDown));

    // 目を離しているあいだに CLI・MCP・他の端末が data/ を書き換えている。
    // アプリはファイルを監視しないので、戻ってきた瞬間を合図に読み直す。
    // Android では凍結されたプロセスが起きる唯一の合図でもある
    const onVisible = (): void => {
      if (document.visibilityState === "visible") {
        shell.refreshData();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    onCleanup(() => document.removeEventListener("visibilitychange", onVisible));

    // デスクトップでは窓を隠さずに他のアプリへ移るので visibilitychange が
    // 来ない。窓のフォーカスが戻ったことは Tauri 側からしか分からない
    let unlistenFocus: UnlistenFn | undefined;
    void (async () => {
      try {
        unlistenFocus = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
          if (focused) {
            shell.refreshData();
          }
        });
      } catch {
        // 窓が無い(ブラウザハーネス・テスト)。visibilitychange だけで動く
      }
    })();
    onCleanup(() => unlistenFocus?.());
  });

  return (
    <div class="app">
      <header class="header">
        <nav class="header-tabs">
          <For each={TABS}>
            {(tab) => (
              <A
                href={tab.path}
                class="header-tab"
                classList={{ "header-tab--active": isActive(tab.path) }}
                data-key={shortcutLabel(tab.shortcut)}
              >
                <Icon name={MODE_ICONS[tab.path]} size={16} />
                {MODE_LABELS[tab.path]}
              </A>
            )}
          </For>
        </nav>

        <span class="header-title">
          {MODE_LABELS[location.pathname as RoutePath] ?? "Timeline"}
        </span>

        <button type="button" class="search-field" onClick={openSearch}>
          <Icon name="magnifying-glass" size={15} />
          <span class="search-field-label">{t().header.searchPlaceholder}</span>
          <span class="key-badge">{shortcutLabel("search")}</span>
        </button>

        <div class="header-actions">
          {/* 幅が狭いと検索フィールドが隠れるので、代わりの入口を用意する */}
          <button
            type="button"
            class="icon-button header-action header-action--search"
            title={t().header.search}
            aria-label={t().header.search}
            onClick={openSearch}
          >
            <Icon name="magnifying-glass" size={18} />
          </button>
          {/* ポップオーバー本体は Timeline が持つ。記録のある日を知っているのは向こう */}
          <Show when={isActive(ROUTES.TIMELINE)}>
            <button
              type="button"
              class="icon-button header-action"
              title={t().header.jumpToDate}
              aria-label={t().header.jumpToDate}
              aria-expanded={shell.popover() === "calendar"}
              onClick={() => shell.togglePopover("calendar")}
            >
              <Icon name="calendar-blank" size={18} />
            </button>
          </Show>
          <button
            type="button"
            class="icon-button header-action"
            title={t().header.sync}
            aria-label={t().header.sync}
            aria-expanded={shell.popover() === "sync"}
            data-key={shortcutLabel("syncNow")}
            onClick={() => shell.togglePopover("sync")}
          >
            <Icon name={syncIconName(sync.status())} size={18} />
          </button>
          <A
            href={ROUTES.SETTINGS}
            class="icon-button header-action header-action--settings"
            title={t().header.settings}
            data-key={shortcutLabel("settings")}
          >
            <Icon name="gear" size={18} />
          </A>
        </div>

        <Show when={shell.popover() === "sync"}>
          <div class="popover-anchor popover-anchor--sync">
            <SyncPopover sync={sync} onClose={() => shell.closePopovers()} />
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

      {/* 札だけでは「なぜ出たか」「どう消すか」が分からない。説明はここ 1 つ */}
      <Show when={hints.visible()}>
        <div class="hint-pill" aria-hidden="true">
          {t().hints.pill(modifierLabel())}
        </div>
      </Show>

      <UndoToast />

      <FirstRunCard
        when={sync.status() === "needs-setup"}
        onConnected={() => navigate(ROUTES.SETTINGS)}
      />

      <Show when={shell.paletteOpen()}>
        <CommandPalette
          scopeTags={shell.paletteScope()?.tags ?? []}
          commands={commands().map((command) => ({
            id: command.id,
            label: command.label,
            icon: command.icon,
            shortcut: shortcutLabel(command.shortcut),
            run: command.run,
          }))}
          onSelectHit={(hit) => {
            shell.closePalette();
            // モードの切り替えだけでは「見つけたのに探し直す」ことになる。
            // ノートはその 1 件を、タイムラインはその日を URL で指す
            if (hit.kind === "note" && hit.filename) {
              navigate(`${ROUTES.NOTES}?file=${encodeURIComponent(hit.filename)}`);
            } else {
              navigate(`${ROUTES.TIMELINE}?day=${hit.date}`);
            }
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
