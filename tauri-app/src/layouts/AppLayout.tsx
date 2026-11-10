import { createEffect, createMemo, onCleanup, onMount, untrack, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import Icon from "../components/Icon";
import CommandPalette from "../components/CommandPalette";
import Popover from "../components/Popover";
import SearchField from "../components/SearchField";
import StatusDot, { StatusDetails, StatusDotButton, StatusLinks } from "../components/StatusDot";
import SyncPopover from "../components/SyncPopover";
import UndoToast from "../components/UndoToast";
import FirstRunCard from "../components/FirstRunCard";
import { ShellProvider, useShell } from "../lib/shell";
import { watchLeave } from "../lib/leave";
import { watchReturn } from "../lib/return";
import { createSyncState, syncAlertText } from "../lib/sync";
import { applyTheme, theme } from "../lib/theme";
import { t } from "../lib/i18n";
import { createHints } from "../lib/hints";
import {
  isTypingTarget,
  matchesShortcut,
  modifierLabel,
  SHORTCUT_LIST_KEY,
  startsTypedSearch,
} from "../lib/shortcuts";
import { ROUTES, routeLabel } from "../lib/routes";
import type { RoutePath } from "../lib/routes";
import { noteRoute, writeRoute } from "../lib/note-route";
import { typedInvoke } from "../lib/commands";
import type { SearchHit } from "../lib/commands";
import { paletteScopeAt } from "../lib/search-scope";
import { commandRows, shellCommands } from "../lib/shell-commands";
import { createWidgetLaunch, watchWidgetLaunch } from "../lib/widget-launch";
import { getDeviceSignals, warmLocation } from "../lib/client-context";
import { applyStartFullscreen } from "../lib/fullscreen";
import { loadGlyphs } from "../lib/glyphs";

/** A screen set to system switches the moment the device setting changes. */
function onSchemeChange(): void {
  if (theme() === "system") {
    applyTheme("system");
  }
}

/** Resolves to a stop function later; the cleanup calls whatever has arrived by then. */
function watchUntilCleanup(watch: () => Promise<() => void>): void {
  let stop: (() => void) | undefined;
  void (async () => {
    stop = await watch();
  })();
  onCleanup(() => stop?.());
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
      let path;
      try {
        path = await typedInvoke("create_draft", {
          body: "",
          tags: [],
          client: await getDeviceSignals(),
        });
      } catch {
        shell.showToast(t().notes.createFailed);
        return;
      }
      shell.refreshData();
      navigate(writeRoute("note", path.split("/").at(-1)));
    })();
  };

  const go = (path: RoutePath) => (): void => {
    shell.closePalette();
    navigate(path);
  };

  // The table is also the shortcut list `?` opens (lib/shell-commands.ts)
  const commands = createMemo(() =>
    shellCommands({
      newNote,
      go,
      syncNow: () => {
        shell.closePalette();
        void sync.syncNow();
      },
    }),
  );
  const rows = createMemo(() => commandRows(commands()));

  const runWidgetAction = createWidgetLaunch({
    navigate,
    newNote,
    closePalette: () => shell.closePalette(),
    refreshData: () => shell.refreshData(),
    showToast: (text) => shell.showToast(text),
  });

  onMount(() => {
    // So the first record does not wait for a position fix, start measuring now if already permitted
    warmLocation();

    // The Settings screen is lazy-loaded, so the window's shape at startup is decided here
    void applyStartFullscreen();

    watchUntilCleanup(() => watchWidgetLaunch(runWidgetAction));

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
      for (const command of commands()) {
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

    // Coming back is the signal to reread what the CLI, MCP or another device wrote
    // meanwhile, and to pull the other devices' writes in if the user asked (lib/return.ts)
    watchUntilCleanup(() =>
      watchReturn(() => {
        shell.refreshData();
        sync.resume();
      }),
    );

    // Leaving is the mirror image. On Android the process may not come back, so what
    // is still pending is written now, by the screens that hold it
    watchUntilCleanup(() =>
      watchLeave(() => {
        // The writes first: a sync that ran before them would leave the last words unsent
        void (async () => {
          await shell.leave();
          sync.leave();
        })();
      }),
    );
  });

  return (
    <div class="app">
      <div class="app-column">
        {/* A narrow screen has no hover and no room in the corner. The title and a few entries make a strip */}
        <header class="mobile-header">
          <span class="mobile-header-title">{routeLabel(location.pathname)}</span>

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
                commands={rows()}
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
          commands={rows()}
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
