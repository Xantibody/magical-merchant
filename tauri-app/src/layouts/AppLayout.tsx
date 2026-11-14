import { createEffect, createMemo, on, onCleanup, onMount, untrack, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { useLocation, useNavigate } from "@solidjs/router";
import Icon from "../components/Icon";
import CommandPalette from "../components/CommandPalette";
import Popover from "../components/Popover";
import SearchField from "../components/SearchField";
import Library from "../components/Library";
import QuickJot from "../components/QuickJot";
import CaptureStandIn from "../components/CaptureStandIn";
import {
  isBrowserMock,
  isCaptureKey,
  setStandIn,
  standIn,
  watchCaptured,
} from "../lib/capture-window";
import SheetGrip from "../components/SheetGrip";
import {
  StatusDetails,
  StatusDotButton,
  StatusLinks,
  saveWords,
  statusWords,
  dotTone,
} from "../components/StatusDot";
import SyncPopover from "../components/SyncPopover";
import UndoToast from "../components/UndoToast";
import FirstRunCard from "../components/FirstRunCard";
import PlaceSwitch from "../components/PlaceSwitch";
import { foldRing, ringStanding } from "../components/Ring";
import { createKeyboardInset } from "../lib/keyboard-inset";
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
import { ringChoices } from "../lib/ring";
import type { RoutePath } from "../lib/routes";
import { noteRoute, writeRoute } from "../lib/note-route";
import { typedInvoke } from "../lib/commands";
import type { NoteKind, SearchHit } from "../lib/commands";
import { paletteScopeAt } from "../lib/search-scope";
import { commandRows, shellCommands } from "../lib/shell-commands";
import { createWidgetLaunch, watchWidgetLaunch } from "../lib/widget-launch";
import { getDeviceSignals, warmLocation } from "../lib/client-context";
import { applyStartFullscreen } from "../lib/fullscreen";
import { loadGlyphs } from "../lib/glyphs";
import { createWide } from "../lib/media";
import { attachGestures } from "../lib/palm-gestures";
import { watchSlim } from "../lib/slim";
import { systemBackStep } from "../lib/system-back";

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
  /** The writing screen is up (the URL carries it): nothing floats over the writing hand. */
  const writing = (): boolean => new URLSearchParams(location.search).get("edit") === "1";
  const wide = createWide();
  /**
   * Lifts what is typed into at the foot over the keyboard: the pill holding Scrawl's field, the
   * one-line window, and the search field, which lies at the foot too (reach.css).
   */
  const keyboard = createKeyboardInset(
    () => !wide() && (isActive(ROUTES.SCRAWL) || shell.quickJot() || shell.searchSeed() !== null),
  );

  // A move brings the bar back whole: the new screen has not been read yet
  createEffect(
    on(
      () => location.pathname,
      () => {
        shell.setSlim(false);
        shell.setQuickJot(false);
      },
      { defer: true },
    ),
  );

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

  /** An empty record of `kind`, opened to write: a petal of the ring, from wherever it bloomed. */
  const newOf = (kind: NoteKind): void => {
    shell.closePalette();
    void (async () => {
      let path;
      try {
        path = await typedInvoke("create_draft", {
          body: "",
          tags: [],
          kind,
          client: await getDeviceSignals(),
        });
      } catch {
        shell.showToast(kind === "codex" ? t().codex.createFailed : t().notes.createFailed);
        return;
      }
      shell.refreshData();
      navigate(writeRoute(kind, path.split("/").at(-1)));
    })();
  };

  /**
   * The template sheet: it hangs from a list's own "new", so from anywhere else the Note list is
   * where it opens. Arriving there mounts the list first, and the sheet opens over it.
   */
  const openTemplates = (): void => {
    if (!isActive(ROUTES.NOTES) && !isActive(ROUTES.CODEX)) {
      navigate(ROUTES.NOTES);
    }
    shell.closePopovers();
    requestAnimationFrame(() => shell.togglePopover("new-note-menu"));
  };

  /** Scrawl's own field, under the thumb: the pill brought back whole if reading had folded it. */
  const focusScrawlField = (): void => {
    shell.setSlim(false);
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLTextAreaElement>(".scrawl .capture-input, .scrawl-dock .capture-input")
        ?.focus(),
    );
  };

  // The ring's petals from the pill and a wide window's shelf (lib/ring.ts keeps their one
  // order). On Scrawl the line is the field right there
  const ring = createMemo(() => {
    const onScrawl = isActive(ROUTES.SCRAWL);
    return ringChoices({
      onScrawl,
      jot: () => (onScrawl ? focusScrawlField() : shell.setQuickJot(true)),
      note: () => newOf("note"),
      codex: () => newOf("codex"),
      template: openTemplates,
    });
  });

  const go = (path: RoutePath) => (): void => {
    shell.closePalette();
    // The place you are on, pressed again with its list tucked under the note: the list is
    // what was asked for, and navigating to the same path would show nothing new
    const sheet = shell.pageLevels()?.beside;
    if (location.pathname === path && sheet?.tucked()) {
      sheet.tuck(false);
      return;
    }
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
      // The grip's key: the sheet beside the page (a note's list). Without one it does nothing
      toggleSidebar: () => {
        shell.closePalette();
        const sheet = shell.pageLevels()?.beside;
        sheet?.tuck(!sheet.tucked());
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

  // ---- the palm: what a finger does on a phone (lib/palm-gestures.ts) ----

  /** A screen with a level below it: a note over its list, writing over reading. */
  const canGoBack = (): boolean => shell.headerBack() !== null;
  /**
   * A level that is a form being filled in (a template open in its editor), like writing: the
   * keyboard and the form's own bar have the foot, so the pill and the round way out step away
   * and the form's own back at its top stands in.
   */
  const editingLevel = (): boolean => writing() || (isActive(ROUTES.TEMPLATES) && canGoBack());
  /**
   * Whether the place pill stands. It does on every screen, Settings, Templates and Browse
   * included: those are reached from the empty search field, and without the pill under them
   * the only way out would be through that field again (P8). Not while writing: the keyboard
   * has the foot then.
   */
  const placesShown = (): boolean =>
    !wide() && !editingLevel() && !shell.placesAway() && !shell.paper() && !shell.quickJot();
  /**
   * A phone's round way out, low on the left where the thumb already is: shown on a level that
   * is read (a note, a Settings page), after the pill, which keeps its place (palm.css). It is
   * what a stroke to the right does there, so the stroke always has a button to match (60).
   */
  const outShown = (): boolean =>
    !wide() && canGoBack() && !editingLevel() && !shell.paper() && !shell.quickJot();
  /** The bar folded to its line of words (4, 12, 63). Never while something is being typed. */
  const slimShown = (): boolean => placesShown() && shell.slim();
  const words = (): string => statusWords(shell.saveState(), sync.status());
  /** The note being read, named on the folded bar once its own title has scrolled away (56). */
  const slimTitle = (): string | undefined => (canGoBack() ? shell.noteState()?.title : undefined);
  /**
   * The folded bar's words. Beside a title there is room for one half at 390px: while all is
   * well the dot says the sync and the words say the save, whole, and the title takes the cut.
   * Anything not well is said in full.
   */
  const slimWords = (): string =>
    slimTitle() && dotTone(shell.saveState().status, sync.status()) === "ok"
      ? saveWords(shell.saveState(), sync.status())
      : words();

  /** One press of the system's back: the topmost layer goes, as a stroke to the right does. */
  const runSystemBack = (historyLeft: boolean, leave: () => void): void => {
    const step = systemBackStep({
      ringOpen: ringStanding(),
      jotOpen: shell.quickJot(),
      searchOpen: shell.searchSeed() !== null,
      paletteOpen: shell.paletteOpen(),
      paper: shell.paper(),
      level: shell.headerBack() !== null,
      canGoBack: historyLeft,
    });
    switch (step) {
      case "ring": {
        foldRing();
        break;
      }
      case "jot": {
        shell.setQuickJot(false);
        break;
      }
      case "search": {
        shell.closeSearch();
        break;
      }
      case "palette": {
        shell.closePalette();
        break;
      }
      case "paper": {
        shell.setPaper(false);
        break;
      }
      case "level": {
        shell.headerBack()?.();
        break;
      }
      case "history": {
        globalThis.history.back();
        break;
      }
      default: {
        leave();
      }
    }
  };

  let appRef: HTMLDivElement | undefined;

  onMount(() => {
    // So the first record does not wait for a position fix, start measuring now if already permitted
    warmLocation();

    // The Settings screen is lazy-loaded, so the window's shape at startup is decided here
    void applyStartFullscreen();

    watchUntilCleanup(() => watchWidgetLaunch(runWidgetAction));

    // A line written from outside the app (the OS key's window, a Spotlight link): whatever is
    // on screen rereads, and the app says where the line came from
    watchUntilCleanup(() =>
      watchCaptured((captured) => {
        shell.refreshData();
        shell.recordsChanged();
        shell.showToast(
          captured.via === "link" ? t().reach.capturedLink : t().reach.capturedWindow,
        );
      }),
    );

    // Android's own back peels the same layers as the stroke to the right, not the browser
    // history (lib/system-back.ts). The app module loads on demand: it is Android's alone, and
    // an eager import would carry it into every platform's startup
    if (navigator.userAgent.includes("Android")) {
      watchUntilCleanup(async () => {
        try {
          const { onBackButtonPress, exit } = await import("@tauri-apps/api/app");
          const listener = await onBackButtonPress((press) => {
            runSystemBack(press.canGoBack, () => {
              void exit(0);
            });
          });
          return () => {
            void listener.unregister();
          };
        } catch {
          // An older shell without the listener keeps the WebView's own back
          return () => {
            // Nothing was registered, so nothing to take off
          };
        }
      });
    }

    if (appRef) {
      const root = appRef;
      onCleanup(
        attachGestures(root, {
          screen: () => ({
            canGoBack: canGoBack(),
            sheet: shell.noteState() !== null && canGoBack() && !writing(),
          }),
          back: () => shell.backStage()?.() ?? null,
          sheet: () => shell.noteState()?.openSettings(),
          paper: () => shell.setPaper(!shell.paper()),
          // The page's own levels (writing, the list). The shelf is a rail that never moves
          wide: {
            active: wide,
            out: () => shell.pageLevels()?.out() ?? null,
            cover: () => shell.pageLevels()?.cover() ?? null,
            page: () => root.querySelector<HTMLElement>(".workspace .detail-pane"),
          },
        }),
      );
      onCleanup(watchSlim(root, (slim) => shell.setSlim(slim)));
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      hints.keyDown(e);

      // The OS key (38, 67) belongs to the OS in the app; the harness has no OS, so the page
      // answers it itself with the stand-in: up, then the same key sends (or puts it away)
      if (isBrowserMock() && isCaptureKey(e)) {
        e.preventDefault();
        if (!standIn()) {
          setStandIn(true);
          return;
        }
        const field = document.querySelector<HTMLTextAreaElement>(
          ".capture-stand-in .capture-input",
        );
        if (field?.value.trim()) {
          document.querySelector<HTMLButtonElement>(".capture-stand-in .capture-send")?.click();
        } else {
          setStandIn(false);
        }
        return;
      }

      if (matchesShortcut(e, "search")) {
        e.preventDefault();
        openSearch();
        return;
      }
      for (const command of commands()) {
        if (command.shortcut && matchesShortcut(e, command.shortcut)) {
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
        // The page alone is left by the same key that leaves everything else
        shell.setPaper(false);
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

  /** The sheet beside a wide window's page (a note's list), which the page's grip moves. */
  const beside = () => shell.pageLevels()?.beside ?? null;
  /** One level out, the same as a stroke to the right. Only shown on a level (`outShown`). */
  const outward = (): void => {
    shell.closeSearch();
    shell.headerBack()?.();
  };

  return (
    <div
      class="app"
      ref={appRef}
      classList={{
        "app--paper": shell.paper(),
      }}
    >
      {/* The first of the three panes. A phone has none: its places are on the pill */}
      <Show when={wide()}>
        <Library
          sync={sync.status()}
          onOpenStatus={openStatus}
          onGo={(path) => go(path)()}
          onSearch={openSearch}
          choices={ring()}
        />
      </Show>

      <div class="app-column">
        {/* A note's page lies on its list, and the grip at the note's own edge (Workspace hands
            it over) tucks that list under the page; the wrapper adds no box of its own there.
            A page with no list beside it has no grip: there is nothing for one to move */}
        <Show when={wide()}>
          <Show when={beside()}>
            {(sheet) => (
              <Portal
                mount={sheet().edge}
                ref={(el) => {
                  el.style.display = "contents";
                }}
              >
                <SheetGrip
                  open={!sheet().tucked()}
                  label={sheet().tucked() ? t().palm.listOut : t().palm.listTuck}
                  onToggle={() => sheet().tuck(!sheet().tucked())}
                  onCover={() => sheet().tuck(true)}
                  onOut={() => sheet().tuck(false)}
                />
              </Portal>
            )}
          </Show>
        </Show>
        {/* A phone has no bar at the top: nothing up there is pressed, so nothing has to be
            reached for. The page runs to the top edge and fades there (58); every control is
            at the foot, where the thumb is (palm.css) */}
        <main class="app-main">
          <div class="app-route">
            {props.children}
            {/* Here rather than in each surface, so the move between Scrawl and a list keeps
                the one element and its stretch can be seen */}
            <Show when={placesShown()}>
              <PlaceSwitch
                stretched={isActive(ROUTES.SCRAWL)}
                lift={keyboard()}
                slot={shell.setPlacesSlot}
                slim={slimShown()}
                choices={ring()}
              />
            </Show>
            {/* On a level that is read, the way out sits after the pill, low on the left */}
            <Show when={outShown()}>
              <button
                type="button"
                class="palm-out"
                classList={{ "palm-out--slim": slimShown() }}
                title={t().common.back}
                aria-label={t().common.back}
                onClick={outward}
              >
                <Icon name="arrow-left" size={20} />
              </button>
            </Show>
            {/* The state's dot, alone in the top corner: no bar holds it. A press opens the
                details; reading down, the words stand at the foot as well (12). A template's
                editor keeps its own bar up there (save, its menu), and says its own state */}
            <Show when={!wide() && !shell.paper() && !(isActive(ROUTES.TEMPLATES) && canGoBack())}>
              <div class="palm-dot">
                <StatusDotButton sync={sync.status()} onOpen={openStatus} />
              </div>
            </Show>
            {/* The bar folded to a line of words while reading (4, 12): the state is read
                without pressing anything, and pressing the line brings the bar back. On a
                note being read it names the note, whose title has scrolled away up top (56) */}
            <Show when={slimShown()}>
              <button
                type="button"
                class="palm-slim"
                data-tone={dotTone(shell.saveState().status, sync.status())}
                aria-label={`${words()} · ${t().palm.unfold}`}
                onClick={() => shell.setSlim(false)}
              >
                <span class="status-dot-mark" />
                <span class="palm-slim-place">{slimTitle() ?? routeLabel(location.pathname)}</span>
                <span class="palm-slim-words">{slimWords()}</span>
              </button>
            </Show>
          </div>

          <Show when={shell.quickJot() && !wide()}>
            <QuickJot lift={keyboard()} onClose={() => shell.setQuickJot(false)} />
          </Show>

          <Show when={shell.searchSeed()} keyed>
            {(seed) => (
              <SearchField
                seed={seed}
                commands={rows()}
                lift={keyboard()}
                onOpen={(hit) => {
                  shell.closeSearch();
                  openHit(hit);
                }}
                onClose={() => shell.closeSearch()}
              />
            )}
          </Show>
        </main>
      </div>

      {/* The page alone (85). The way back is the same two fingers, or this one quiet button
          for a hand that has only one free */}
      <Show when={shell.paper()}>
        <button
          type="button"
          class="paper-back"
          title={t().palm.paperHint}
          onClick={() => shell.setPaper(false)}
        >
          <Icon name="x" size={14} />
          {t().palm.paperBack}
        </button>
      </Show>

      {/* One status container hangs off the window, whichever dot opened it */}
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

      {/* The badges alone do not say why they appeared or how to dismiss them. This is the one explanation */}
      <Show when={hints.visible()}>
        <div class="hint-pill" aria-hidden="true">
          {t().hints.pill(modifierLabel())}
        </div>
      </Show>

      <UndoToast />

      {/* The harness's stand-in for the window the OS key floats over other apps */}
      <Show when={standIn()}>
        <CaptureStandIn onClose={() => setStandIn(false)} />
      </Show>

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

      {/* A wide window's one-line window floats at the page's foot, centred (68's pointer way) */}
      <Show when={shell.quickJot() && wide()}>
        <QuickJot wide onClose={() => shell.setQuickJot(false)} />
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
