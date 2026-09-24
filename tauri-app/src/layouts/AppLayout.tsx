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
import type { NoteBar } from "../lib/shell";
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

/** A screen set to system switches the moment the device setting changes. */
function onSchemeChange(): void {
  if (theme() === "system") {
    applyTheme("system");
  }
}

/** A state that is on. Pressing it opens the panel where its switch is. */
function StateChip(props: { icon: IconName; label: string; onOpen: () => void }): JSX.Element {
  return (
    <>
      <span class="bottom-bar-sep" aria-hidden="true">
        ·
      </span>
      <button type="button" class="bottom-bar-state" onClick={() => props.onOpen()}>
        <Icon name={props.icon} size={12} />
        {props.label}
      </button>
    </>
  );
}

/**
 * The open note's part of the bottom bar: the version, comparing, the states that are on,
 * and at the right end the two actions worth offering right now. Only states that are on
 * appear, so a plain note adds nothing to the line.
 */
function NoteStatus(props: { bar: NoteBar }): JSX.Element {
  return (
    <>
      <Show when={props.bar.version}>
        {(version) => (
          <>
            <span class="bottom-bar-sep" aria-hidden="true">
              ·
            </span>
            <span class="bottom-bar-version">{version()}</span>
          </>
        )}
      </Show>
      <Show when={props.bar.comparing}>
        {(comparing) => (
          <StateChip
            icon="clock-counter-clockwise"
            label={comparing()}
            onOpen={props.bar.openHistory}
          />
        )}
      </Show>
      <Show when={props.bar.readOnly}>
        <StateChip icon="lock-simple" label={t().notes.readOnly} onOpen={props.bar.openSettings} />
      </Show>
      <Show when={props.bar.map}>
        <StateChip icon="tree-structure" label={t().notes.map} onOpen={props.bar.openSettings} />
      </Show>
      <Show when={props.bar.examples}>
        <StateChip icon="file-text" label={t().notes.examples} onOpen={props.bar.openSettings} />
      </Show>
      <span class="bottom-bar-actions">
        <Show when={props.bar.canCommit}>
          <button
            type="button"
            class="bottom-bar-action"
            data-hint-key={shortcutLabel("codexCommit")}
            onClick={() => props.bar.commit()}
          >
            <Icon name="book-bookmark" size={13} />
            {t().codex.commit}
          </button>
        </Show>
        <Show when={props.bar.canRevert}>
          <button
            type="button"
            class="bottom-bar-action"
            data-hint-key={shortcutLabel("noteRevert")}
            onClick={() => props.bar.revert()}
          >
            <Icon name="arrow-counter-clockwise" size={13} />
            {t().notes.revert}
          </button>
        </Show>
      </span>
    </>
  );
}

/** An action callable from both a key and the palette. */
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

  // An error is not swallowed silently; the sync popover opens to report it
  createEffect(() => {
    if (sync.alertVersion() > 0) {
      shell.togglePopover("sync");
    }
  });

  const isActive = (path: RoutePath): boolean => location.pathname === path;
  /** Whether the current surface has a list flyout. */
  const hasList = (): boolean => isActive(ROUTES.NOTES) || isActive(ROUTES.CODEX);

  /**
   * If tags are chosen on the Browse screen, search within them. To search everything,
   * removing the chip in the palette is enough; the reverse (recalling the filter later) is hard
   */
  const openSearch = (): void => {
    shell.openPalette(paletteScopeAt(location.pathname, shell.browseFilter().tags));
  };

  // The glyph registry is read once at startup and again on every signal that
  // the data changed (a sync finishing, and so on). No body has an image written
  // in it anywhere, so without the table `:236p:` shows as plain text
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
   * Actions callable from a key and from the palette. Without a single table, the
   * rail's badge would say "Cmd+N" while the key does nothing.
   * This is also the shortcut list itself that `?` opens
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
        navigate(noteRoute("note", filename));
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
    // On Android it is also the only signal that a frozen process has woken
    const onVisible = (): void => {
      if (document.visibilityState === "visible") {
        shell.refreshData();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    onCleanup(() => document.removeEventListener("visibilitychange", onVisible));

    // On desktop, switching to another app does not hide the window, so no
    // visibilitychange arrives. Only the Tauri side knows that focus returned.
    // AIDEV-NOTE: getCurrentWindow().onFocusChanged is not used. The window module drags in dpi/image and becomes 13% of the startup bundle
    let unlistenFocus: UnlistenFn | undefined;
    void (async () => {
      try {
        unlistenFocus = await listen(TauriEvent.WINDOW_FOCUS, () => shell.refreshData());
      } catch {
        // No window (browser harness, tests). visibilitychange alone does the job
      }
    })();
    onCleanup(() => unlistenFocus?.());
  });

  return (
    <div class="app">
      <Rail sync={sync} onSearch={openSearch} />

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

        {/* The status line: where the save landed and what state the open note is in,
            so a closed panel hides nothing. No current location: the rail's line and
            the title are enough. Not shown on a narrow screen (CSS), where it would
            stack with the bottom tabs; there the note's status row carries it */}
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
          <Show when={shell.noteBar()}>{(bar) => <NoteStatus bar={bar()} />}</Show>
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

        {/* The sync entry is on both the rail (wide window) and the strip (narrow
            window), but one container opens. CSS decides which one it hangs under */}
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
          commands={commands().map((command) => ({
            id: command.id,
            label: command.label,
            icon: command.icon,
            shortcut: shortcutLabel(command.shortcut),
            run: command.run,
          }))}
          onSelectHit={(hit) => {
            shell.closePalette();
            // Switching the mode alone would mean "found it, now find it again".
            // The URL points at that one note, or at that day for Scrawl
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
