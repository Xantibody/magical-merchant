import { createEffect, createMemo, onCleanup, onMount, untrack, For, Show } from "solid-js";
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
import SearchField from "../components/SearchField";
import StatusDot, { StatusDetails, StatusDotButton, StatusLinks } from "../components/StatusDot";
import SyncPopover from "../components/SyncPopover";
import UndoToast from "../components/UndoToast";
import FirstRunCard from "../components/FirstRunCard";
import { ShellProvider, useShell } from "../lib/shell";
import { watchLeave } from "../lib/leave";
import { createSyncState, syncAlertText } from "../lib/sync";
import { applyTheme, theme } from "../lib/theme";
import { locale, t } from "../lib/i18n";
import { createHints } from "../lib/hints";
import {
  isTypingTarget,
  matchesShortcut,
  modifierLabel,
  shortcutLabel,
  SHORTCUT_LIST_KEY,
  startsTypedSearch,
} from "../lib/shortcuts";
import type { ShortcutName } from "../lib/shortcuts";
import { MODE_ICONS, MODE_LABELS, ROUTES } from "../lib/routes";
import type { RoutePath } from "../lib/routes";
import { noteRoute, writeRoute } from "../lib/note-route";
import { typedInvoke } from "../lib/commands";
import type { SearchHit } from "../lib/commands";
import { paletteScopeAt } from "../lib/search-scope";
import { firstWidgetAction } from "../lib/widget-actions";
import type { WidgetAction } from "../lib/widget-actions";
import { getDeviceSignals, warmLocation } from "../lib/client-context";
import { applyStartFullscreen } from "../lib/fullscreen";
import { loadGlyphs } from "../lib/glyphs";

const BOTTOM_TABS: RoutePath[] = [ROUTES.SCRAWL, ROUTES.NOTES, ROUTES.CODEX, ROUTES.SETTINGS];

/** A screen set to system switches the moment the device setting changes. */
function onSchemeChange(): void {
  if (theme() === "system") {
    applyTheme("system");
  }
}

/** An action callable from both a key and the palette. */
interface ShellCommand {
  id: string;
  label: string;
  icon: IconName;
  shortcut: ShortcutName;
  place?: boolean;
  run: () => void;
}

function Chrome(props: { children?: JSX.Element }): JSX.Element {
  const shell = useShell();
  const location = useLocation();
  const navigate = useNavigate();

  const sync = createSyncState(() => shell.refreshData());
  const hints = createHints();

  // Settings is where it is chosen. This only reapplies the remembered choice at startup
  applyTheme(theme());

  // Badges add no DOM; they are drawn as pseudo-elements. A mark on html reaches the whole screen
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

  // A failure is the one thing that interrupts (ADR 0011). A toast passes on its own where the
  // popover stood over the page; the dot stays red. Status is untracked: only an alert speaks
  createEffect(() => {
    if (sync.alertVersion() > 0) {
      shell.showToast(syncAlertText(untrack(sync.status)));
    }
  });

  const isActive = (path: RoutePath): boolean => location.pathname === path;
  /** Whether the current surface has a list flyout. */
  const hasList = (): boolean => isActive(ROUTES.NOTES) || isActive(ROUTES.CODEX);

  /**
   * If tags are chosen on the Browse screen, search within them. To search everything,
   * removing the chip is enough; the reverse (recalling the filter later) is hard
   */
  const openSearch = (): void => {
    const open = shell.searchSeed() !== null;
    shell.openSearch(
      open ? undefined : paletteScopeAt(location.pathname, shell.browseFilter().tags),
    );
    // Already open with the keys elsewhere: nothing mounts, so nothing would take them back
    document.querySelector<HTMLInputElement>(".search-input")?.focus();
  };

  /** The list of shortcuts. It is the palette's command section, and the palette keeps its home. */
  const openShortcutList = (): void => {
    shell.openPalette(paletteScopeAt(location.pathname, shell.browseFilter().tags));
  };

  /**
   * Scrawl and Browse have no keys of their own. A note's viewer does (e and Enter write), and
   * the window listeners there run in no useful order, so typing does not start a search on it.
   */
  const typingSearches = (): boolean => isActive(ROUTES.SCRAWL) || isActive(ROUTES.BROWSE);

  /** Switching the mode alone would mean "found it, now find it again". */
  const openHit = (hit: SearchHit): void => {
    // The URL points at that one note, or at that day for Scrawl
    if (hit.kind !== "scrawl" && hit.filename) {
      navigate(noteRoute(hit.kind, hit.filename));
    } else {
      navigate(`${ROUTES.SCRAWL}?day=${hit.date}`);
    }
  };

  // The glyph registry is read once at startup and again on every signal that
  // the data changed (a sync finishing, and so on). No body has an image written
  // in it anywhere, so without the table `:236p:` shows as plain text
  createEffect(() => {
    shell.dataVersion();
    void loadGlyphs();
  });

  const openStatus = (trigger: HTMLElement): void => shell.togglePopover("sync", trigger);
  const closeAnd = (run: () => void) => (): void => {
    shell.closePopovers();
    run();
  };

  const newNote = (): void => {
    shell.closePalette();
    void (async () => {
      const path = await typedInvoke("create_draft", {
        body: "",
        tags: [],
        client: await getDeviceSignals(),
      });
      shell.refreshData();
      navigate(writeRoute("note", path.split("/").at(-1)));
    })();
  };

  const go = (path: RoutePath) => (): void => {
    shell.closePalette();
    navigate(path);
  };

  /**
   * Actions callable from a key and from the palette. Without a single table, the
   * rail's badge would say "Cmd+N" while the key does nothing.
   * This is also the shortcut list itself that `?` opens
   */
  const shellCommands = createMemo<ShellCommand[]>(() => [
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
      place: true,
      run: go(ROUTES.SCRAWL),
    },
    {
      id: "go-notes",
      label: t().palette.openNotes,
      icon: MODE_ICONS[ROUTES.NOTES],
      shortcut: "notes",
      place: true,
      run: go(ROUTES.NOTES),
    },
    {
      id: "go-codex",
      label: t().palette.openCodex,
      icon: MODE_ICONS[ROUTES.CODEX],
      shortcut: "codex",
      place: true,
      run: go(ROUTES.CODEX),
    },
    {
      id: "go-browse",
      label: t().palette.openBrowse,
      icon: MODE_ICONS[ROUTES.BROWSE],
      shortcut: "browse",
      place: true,
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
      place: true,
      run: go(ROUTES.SETTINGS),
    },
  ]);

  /** The same rows for the palette and the search field, with the key spelled out. */
  const commandRows = createMemo(() =>
    shellCommands().map((command) => ({
      id: command.id,
      label: command.label,
      icon: command.icon,
      shortcut: shortcutLabel(command.shortcut),
      place: command.place,
      run: command.run,
    })),
  );

  /**
   * A widget's template button. If today's note from the same template already
   * exists, core returns it instead of creating one, so this only has to open it.
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
        navigate(writeRoute("note", filename));
      } catch {
        // A widget may still point at a template that was deleted. Rather than
        // nothing happening on tap, open the list and show the reason
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
    // Where a widget with no buttons at all, and its header, lead
    if (action.name === "templates") {
      navigate(ROUTES.TEMPLATES);
      return;
    }
    // ?file= is left to the router. Carrying the wanted note in the URL is more
    // natural than lifting the Workspace selection state out to be touched from outside
    if (action.name === "note" && action.file) {
      navigate(noteRoute("note", action.file));
    }
  };

  onMount(() => {
    // So the first record does not wait for a position fix, start measuring now if already permitted
    warmLocation();

    // The Settings screen is lazy-loaded, so the window's shape at startup is decided here
    void applyStartFullscreen();

    // A widget tap usually wakes the app from cold. onOpenUrl only delivers what
    // arrives after subscribing, so the launch URL is picked up with getCurrent.
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
      // Only Note and Codex have the list flyout. On other surfaces the key passes through
      if (matchesShortcut(e, "listPin") && hasList()) {
        e.preventDefault();
        shell.toggleListPin();
        return;
      }
      for (const command of shellCommands()) {
        if (matchesShortcut(e, command.shortcut)) {
          e.preventDefault();
          command.run();
          return;
        }
      }
      // The list is the palette's command section itself; not enough content for its own screen.
      // The key has no modifier, so while typing it passes through as a character
      if (e.key === SHORTCUT_LIST_KEY && !shell.paletteOpen() && !isTypingTarget(e.target)) {
        e.preventDefault();
        openShortcutList();
        return;
      }
      if (
        typingSearches() &&
        startsTypedSearch(e) &&
        !shell.paletteOpen() &&
        !shell.searchSeed() &&
        !shell.popover()
      ) {
        shell.openSearch();
        return;
      }
      if (e.key === "Escape") {
        shell.closePopovers();
        shell.closePalette();
      }
    };
    globalThis.addEventListener("keydown", onKeyDown);
    onCleanup(() => globalThis.removeEventListener("keydown", onKeyDown));

    // Hide the moment the key is released. Leaving the window (Cmd+Tab) sends no keyup, so blur is watched too
    const onKeyUp = (e: KeyboardEvent): void => hints.keyUp(e);
    const onBlur = (): void => hints.hide();
    globalThis.addEventListener("keyup", onKeyUp);
    globalThis.addEventListener("blur", onBlur);
    onCleanup(() => {
      globalThis.removeEventListener("keyup", onKeyUp);
      globalThis.removeEventListener("blur", onBlur);
    });

    // While nobody is looking, the CLI, MCP or another device rewrites data/.
    // The app does not watch files, so the moment of coming back is the signal to reread.
    // On Android it is also the only signal that a frozen process has woken.
    // It is also when another device's writes should be pulled in, if the user asked
    const onReturn = (): void => {
      shell.refreshData();
      sync.resume();
    };
    const onVisible = (): void => {
      if (document.visibilityState === "visible") {
        onReturn();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    onCleanup(() => document.removeEventListener("visibilitychange", onVisible));

    // Leaving is the mirror image. On Android the process may not come back, so what
    // is still pending is written now, by the screens that hold it
    let unwatchLeave: (() => void) | undefined;
    void (async () => {
      unwatchLeave = await watchLeave(() => {
        // The writes first: a sync that ran before them would leave the last words unsent
        void (async () => {
          await shell.leave();
          sync.leave();
        })();
      });
    })();
    onCleanup(() => unwatchLeave?.());

    // On desktop, switching to another app does not hide the window, so no
    // visibilitychange arrives. Only the Tauri side knows that focus returned.
    // AIDEV-NOTE: getCurrentWindow().onFocusChanged is not used. The window module drags in dpi/image and becomes 13% of the startup bundle
    let unlistenFocus: UnlistenFn | undefined;
    void (async () => {
      try {
        unlistenFocus = await listen(TauriEvent.WINDOW_FOCUS, onReturn);
      } catch {
        // No window (browser harness, tests). visibilitychange alone does the job
      }
    })();
    onCleanup(() => unlistenFocus?.());
  });

  return (
    <div class="app">
      <Rail onSearch={openSearch} />

      <div class="app-column">
        {/* A narrow screen has no width for the rail. The title and a few entries make a strip */}
        <header class="mobile-header">
          <span class="mobile-header-title">
            {MODE_LABELS[location.pathname as RoutePath] ?? MODE_LABELS[ROUTES.SCRAWL]}
          </span>

          <div class="mobile-header-actions">
            {/* The popover itself belongs to Scrawl. That side is what knows the recorded days */}
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
            <StatusDotButton sync={sync.status()} onOpen={openStatus} />
          </div>
        </header>

        <main class="app-main">
          {props.children}
          <Show when={shell.searchSeed()} keyed>
            {(seed) => (
              <SearchField
                seed={seed}
                commands={commandRows()}
                onOpen={(hit) => {
                  shell.closeSearch();
                  openHit(hit);
                }}
                onClose={() => shell.closeSearch()}
              />
            )}
          </Show>
        </main>

        <StatusDot
          sync={sync.status()}
          onOpen={openStatus}
          onScrawl={go(ROUTES.SCRAWL)}
          onSearch={openSearch}
          onSettings={go(ROUTES.SETTINGS)}
          onKeys={openShortcutList}
        />

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

        {/* The dot is at the window's corner (wide) or in the strip (narrow), but one
            container opens. CSS decides which one it hangs from */}
        <Popover
          open={shell.popover() === "sync"}
          onClose={() => shell.closePopovers()}
          trigger={shell.popoverTrigger}
          label={t().header.sync}
          class="popover-anchor popover-anchor--sync"
        >
          <SyncPopover
            sync={sync}
            onClose={() => shell.closePopovers()}
            foot={
              <StatusLinks
                onScrawl={closeAnd(go(ROUTES.SCRAWL))}
                onSearch={closeAnd(openSearch)}
                onSettings={closeAnd(go(ROUTES.SETTINGS))}
                onKeys={openShortcutList}
              />
            }
          >
            <StatusDetails onClose={() => shell.closePopovers()} />
          </SyncPopover>
        </Popover>
      </div>

      {/* The badges alone do not say why they appeared or how to dismiss them. This is the one explanation */}
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
          commands={commandRows()}
          onSelectHit={(hit) => {
            shell.closePalette();
            openHit(hit);
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
