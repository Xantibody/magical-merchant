import { createEffect, createMemo, onCleanup, onMount, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useLocation, useNavigate, A } from "@solidjs/router";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { listen, TauriEvent } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import Icon from "../components/Icon";
import type { IconName } from "../components/Icon";
import CommandPalette from "../components/CommandPalette";
import Popover from "../components/Popover";
import Rail from "../components/Rail";
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
import { noteRoute } from "../lib/note-route";
import { typedInvoke } from "../lib/commands";
import { paletteScopeAt } from "../lib/search-scope";
import { firstWidgetAction } from "../lib/widget-actions";
import type { WidgetAction } from "../lib/widget-actions";
import { getDeviceSignals, warmLocation } from "../lib/client-context";
import { applyStartFullscreen } from "../lib/fullscreen";
import { loadGlyphs } from "../lib/glyphs";

const BOTTOM_TABS: RoutePath[] = [ROUTES.SCRAWL, ROUTES.NOTES, ROUTES.CODEX, ROUTES.SETTINGS];

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
  /** 一覧フライアウトを持つ面に居るか。 */
  const hasList = (): boolean => isActive(ROUTES.NOTES) || isActive(ROUTES.CODEX);

  /**
   * 絞る画面でタグを選んでいるなら、その中を探す。全体を探したければ
   * パレットのチップを外せばよく、逆(絞り込みを後から思い出す)は難しい
   */
  const openSearch = (): void => {
    shell.openPalette(paletteScopeAt(location.pathname, shell.browseFilter().tags));
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
      id: "go-scrawl",
      label: t().palette.openScrawl,
      icon: MODE_ICONS[ROUTES.SCRAWL],
      shortcut: "scrawl",
      run: go(ROUTES.SCRAWL),
    },
    {
      id: "go-notes",
      label: t().palette.openNotes,
      icon: MODE_ICONS[ROUTES.NOTES],
      shortcut: "notes",
      run: go(ROUTES.NOTES),
    },
    {
      id: "go-codex",
      label: t().palette.openCodex,
      icon: MODE_ICONS[ROUTES.CODEX],
      shortcut: "codex",
      run: go(ROUTES.CODEX),
    },
    {
      id: "go-browse",
      label: t().palette.openBrowse,
      icon: MODE_ICONS[ROUTES.BROWSE],
      shortcut: "browse",
      run: go(ROUTES.BROWSE),
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
        navigate(noteRoute("note", filename));
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
      navigate(noteRoute("note", action.file));
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
      // 一覧フライアウトは Note と Codex にしかない。他の面では素通しする
      if (matchesShortcut(e, "listPin") && hasList()) {
        e.preventDefault();
        shell.toggleListPin();
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
    // 来ない。窓のフォーカスが戻ったことは Tauri 側からしか分からない。
    // AIDEV-NOTE: getCurrentWindow().onFocusChanged は使わない。window モジュールが dpi/image を連れて起動バンドルの 13% になる
    let unlistenFocus: UnlistenFn | undefined;
    void (async () => {
      try {
        unlistenFocus = await listen(TauriEvent.WINDOW_FOCUS, () => shell.refreshData());
      } catch {
        // 窓が無い(ブラウザハーネス・テスト)。visibilitychange だけで動く
      }
    })();
    onCleanup(() => unlistenFocus?.());
  });

  return (
    <div class="app">
      <Rail sync={sync} onSearch={openSearch} />

      <div class="app-column">
        {/* 狭い画面にはレールを立てる幅が無い。題と数個の入口だけを帯にする */}
        <header class="mobile-header">
          <span class="mobile-header-title">
            {MODE_LABELS[location.pathname as RoutePath] ?? MODE_LABELS[ROUTES.SCRAWL]}
          </span>

          <div class="mobile-header-actions">
            {/* ポップオーバー本体は Scrawl が持つ。記録のある日を知っているのは向こう */}
            <Show when={isActive(ROUTES.SCRAWL)}>
              <button
                type="button"
                class="icon-button"
                title={t().header.jumpToDate}
                aria-label={t().header.jumpToDate}
                aria-expanded={shell.popover() === "calendar"}
                onClick={(e) => shell.togglePopover("calendar", e.currentTarget)}
              >
                <Icon name="calendar-blank" size={18} />
              </button>
            </Show>
            <button
              type="button"
              class="icon-button"
              title={t().header.search}
              aria-label={t().header.search}
              onClick={openSearch}
            >
              <Icon name="magnifying-glass" size={18} />
            </button>
            <button
              type="button"
              class="icon-button"
              title={t().header.sync}
              aria-label={t().header.sync}
              aria-expanded={shell.popover() === "sync"}
              onClick={(e) => shell.togglePopover("sync", e.currentTarget)}
            >
              <Icon name={syncIconName(sync.status())} size={18} />
            </button>
          </div>
        </header>

        <main class="app-main">{props.children}</main>

        {/* 着地したことだけを言う細い帯。現在地は出さない — レールの線と題で
            足りる。狭い画面には出さない(CSS)。下タブと二段になるので、
            そちらでは保存の様子をメタ行が持つ */}
        <div class="bottom-bar">
          <Show when={shell.saveState().status !== "idle"}>
            <span class="bottom-bar-save" data-status={shell.saveState().status}>
              <Show when={shell.saveState().status !== "saving"}>
                <Icon name="check" size={13} />
              </Show>
              {shell.saveState().status === "saving" ? t().common.saving : null}
              {shell.saveState().status === "saved" ? t().common.saved : null}
              {shell.saveState().status === "savedAt"
                ? t().notes.savedAt(shell.saveState().at)
                : null}
            </span>
          </Show>
        </div>

        <nav class="bottom-tabs">
          <For each={BOTTOM_TABS}>
            {(path) => (
              <A
                href={path}
                class="bottom-tab"
                classList={{ "bottom-tab--active": isActive(path) }}
              >
                <Icon name={MODE_ICONS[path]} size={22} />
                {MODE_LABELS[path]}
              </A>
            )}
          </For>
        </nav>

        {/* 同期の入口はレール(広い窓)と帯(狭い窓)の両方にあるが、開く器は
            1 つ。どちらの足元に吊るすかは CSS が決める */}
        <Popover
          open={shell.popover() === "sync"}
          onClose={() => shell.closePopovers()}
          trigger={shell.popoverTrigger}
          label={t().header.sync}
          class="popover-anchor popover-anchor--sync"
        >
          <SyncPopover sync={sync} onClose={() => shell.closePopovers()} />
        </Popover>
      </div>

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
            // ノートはその 1 件を、Scrawl はその日を URL で指す
            if (hit.kind !== "scrawl" && hit.filename) {
              navigate(noteRoute(hit.kind, hit.filename));
            } else {
              navigate(`${ROUTES.SCRAWL}?day=${hit.date}`);
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
