import { createContext, createSignal, useContext, onCleanup } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import { NO_FILTER } from "./browse";
import type { BrowseFilter } from "./browse";
import type { PaletteScope } from "./search-scope";
import { createLeaveHandlers } from "./leave";
import type { LeaveHandlers } from "./leave";
import type { SaveStatus } from "./note-session";
import type { BackStage } from "./palm-gestures";
import type { NoteKind } from "./commands";

/** The save state the status dot wears, and the time of the last successful save. */
interface SaveState {
  status: SaveStatus;
  /** A clock time such as "22:18". It means something only when `status` is `savedAt`. */
  at: string;
}

const IDLE_SAVE: SaveState = { status: "idle", at: "" };

/**
 * What the status dot's details say about the open note besides the save, and the two actions
 * they offer. The note lives in Workspace and the dot in AppLayout, so they meet here the way
 * the save state does. `null` while no note is open.
 */
export interface NoteState {
  /**
   * The note's title: a phone's bar, folded while the page is read, says it beside the save's
   * words (56), so what is read and whether it is kept are one glance at the foot.
   */
  title: string;
  /** Codex only. "+312 B from version 4" and the like. */
  version?: string;
  /** While comparing with a version. "comparing with version 2 · 3 lines added". */
  comparing?: string;
  map: boolean;
  examples: boolean;
  /** Whether "commit a version" is worth offering: a Codex whose draft has moved on. */
  canCommit: boolean;
  /** Whether "back to before this edit" would do anything right now. */
  canRevert: boolean;
  commit: () => void;
  revert: () => void;
  /** Opens the panel pinned on its settings tab. A state in the details leads to its switch. */
  openSettings: () => void;
  /** Opens the panel pinned on the history tab. */
  openHistory: () => void;
}

/**
 * A wide window's levels beside the page, as the page knows them (Workspace: writing over
 * reading, the list beside the note). Each answers what one more step would do, or null when
 * there is no such step here. The shelf is not among them: it is a rail that never moves.
 */
interface PageLevels {
  /** One level out: writing back to reading, a tucked list back beside the note. */
  out: () => (() => void) | null;
  /** The mirror: the level beside the page tucked under it. */
  cover: () => (() => void) | null;
  /**
   * The sheet lying between the page and the shelf (a note's list), which the page's one grip
   * moves; the grip stands on `edge`, the page's own left side. Without it there is no grip:
   * nothing lies beside the page for one to move.
   */
  beside?: {
    tucked: () => boolean;
    tuck: (tucked: boolean) => void;
    edge: HTMLElement;
  };
}

/** What the search field opens with. */
interface SearchSeed {
  tags?: string[];
}

/** Only one popover can be open at a time. */
type PopoverName = "sync" | "calendar" | "new-note-menu" | null;

interface Toast {
  message: string;
  /** When given, an undo action is offered. */
  undo?: () => void;
  /** A faint summary set beside the message, such as "+312 B since version 4, 7 days on". */
  detail?: string;
}

const TOAST_MS = 5000;

/**
 * Remembers a wide window's list tucked under its note: someone who pushed it away to read
 * wide wants the next start to read wide too. Out is the default.
 */
const LIST_TUCK_KEY = "list-tucked";

function readListTucked(): boolean {
  try {
    return localStorage.getItem(LIST_TUCK_KEY) === "tucked";
  } catch {
    return false;
  }
}

function rememberListTucked(tucked: boolean): void {
  try {
    if (tucked) {
      localStorage.setItem(LIST_TUCK_KEY, "tucked");
    } else {
      localStorage.removeItem(LIST_TUCK_KEY);
    }
  } catch {
    // No storage: the list simply comes out again on the next start
  }
}

export interface Shell {
  popover: Accessor<PopoverName>;
  /**
   * Passing the button that opened it stops a press on that button from counting as
   * "outside" (`components/Popover.tsx`). Closing first would let the click that follows
   * open it again, and the same button could not fold it away.
   */
  togglePopover: (name: Exclude<PopoverName, null>, trigger?: HTMLElement) => void;
  /** The button that opened the popover currently open. */
  popoverTrigger: Accessor<HTMLElement | undefined>;
  closePopovers: () => void;
  paletteOpen: Accessor<boolean>;
  /** The scope carried over when it was opened. Without one, everything is searched. */
  paletteScope: Accessor<PaletteScope | null>;
  openPalette: (scope?: PaletteScope) => void;
  closePalette: () => void;
  /** Non-null while the search field is open. A new seed starts it over. */
  searchSeed: Accessor<SearchSeed | null>;
  /** Without a seed, a field already open keeps what is in it. */
  openSearch: (seed?: SearchSeed) => void;
  closeSearch: () => void;
  /**
   * One level out. A screen with a level of its own under the route (a note opened from the
   * list, a Settings page) hands its "back" here, so a phone's round back button, the stroke
   * to the right, Android's back and the place pill all take the same step. Null at the top of
   * a surface, where there is nothing further out.
   */
  headerBack: Accessor<(() => void) | null>;
  setHeaderBack: (back: (() => void) | null) => void;
  /**
   * The part of a phone's place pill that a surface fills with its own controls (Scrawl's
   * field). The pill belongs to the shell so it survives the move between surfaces and can
   * stretch and shrink as one element; what goes in it stays owned by the surface (a Portal).
   * Undefined while no pill is mounted.
   */
  placesSlot: Accessor<HTMLElement | undefined>;
  setPlacesSlot: (slot?: HTMLElement) => void;
  /** A surface sends the pill away while a bar of its own stands there (Scrawl's select mode). */
  placesAway: Accessor<boolean>;
  setPlacesAway: (away: boolean) => void;
  /**
   * Whether the chrome has slimmed while reading (4, 58, 63): the bar at a phone's foot folds to
   * one thin line of words, and a wide window's note strip steps back. A list or a page that
   * scrolls reports it (`lib/slim.ts`); the top of anything brings it back.
   */
  slim: Accessor<boolean>;
  setSlim: (slim: boolean) => void;
  /** The page alone, every bar gone (85). Two fingers tapped twice, or the note panel's switch. */
  paper: Accessor<boolean>;
  setPaper: (paper: boolean) => void;
  /**
   * What a stroke to the right slides away on a screen with a level below it. The screen hands
   * it over (Workspace: the note over its list, writing over reading); null at the top of a
   * surface, where the stroke does nothing.
   */
  backStage: Accessor<(() => BackStage | null) | null>;
  setBackStage: (stage: (() => BackStage | null) | null) => void;
  /**
   * Whether a wide window's list lies tucked under the note, which then takes its room. It
   * belongs to the app, not to one note: the next note opens the same way, and so does the
   * next start (remembered on this device).
   */
  listTucked: Accessor<boolean>;
  setListTucked: (tucked: boolean) => void;
  /** The page's own levels for a wide window's two-finger strokes; null where it has none. */
  pageLevels: Accessor<PageLevels | null>;
  setPageLevels: (levels: PageLevels | null) => void;
  /**
   * The note last opened on each surface. The place pill's Note and Codex go straight back to it
   * (93), the way a writer's machine returns to its draft; a held press is the way to the list.
   */
  lastNote: Accessor<Partial<Record<NoteKind, string>>>;
  setLastNote: (kind: NoteKind, filename: string | undefined) => void;
  /** Whether the one-line window over the place pill is up (68): a Scrawl line from anywhere. */
  quickJot: Accessor<boolean>;
  setQuickJot: (open: boolean) => void;
  /**
   * Whether the note's right panel is docked beside the body. Like `listTucked` it belongs to
   * the app, not to one note: opening the next note keeps it where it was.
   */
  notePanelPinned: Accessor<boolean>;
  setNotePanelPinned: (pinned: boolean) => void;
  noteState: Accessor<NoteState | null>;
  setNoteState: (bar: NoteState | null) => void;
  /**
   * Where the save landed. `Workspace` writes it and the status dot (`AppLayout`) shows it,
   * so they meet here. Leaving the surface resets it to `idle`: carried over, a screen that
   * saved nothing would keep saying "saved at 22:18".
   */
  saveState: Accessor<SaveState>;
  setSaveState: (state: SaveState) => void;
  /**
   * The three axes of the Browse screen. Held inside the screen alone, it would have to be
   * narrowed again on every return, and the tags would not be visible from the `⌘K`
   * handling in AppLayout.
   */
  browseFilter: Accessor<BrowseFilter>;
  setBrowseFilter: (filter: BrowseFilter) => void;
  toast: Accessor<Toast | null>;
  showToast: (message: string, undo?: () => void, detail?: string) => void;
  dismissToast: () => void;
  /** The signal to reread the data. When it increases, everything is fetched again. */
  dataVersion: Accessor<number>;
  refreshData: () => void;
  /**
   * A record was added or removed on this screen. Only the place pill's count of today rereads
   * for it: the screen that wrote has already updated itself, and `refreshData` would reread
   * every view.
   */
  recordsVersion: Accessor<number>;
  recordsChanged: () => void;
  /**
   * The mirror of `refreshData`: the user is leaving the app (`lib/leave.ts`). A screen with
   * something pending registers what writes it; AppLayout runs them all, then syncs.
   */
  onLeave: LeaveHandlers["register"];
  leave: LeaveHandlers["run"];
}

const ShellContext = createContext<Shell>();

export function useShell(): Shell {
  const shell = useContext(ShellContext);
  if (!shell) {
    throw new Error("useShell must be used inside <ShellProvider>");
  }
  return shell;
}

export function ShellProvider(props: { children: JSX.Element }): JSX.Element {
  const leaveHandlers = createLeaveHandlers();
  const [popover, setPopover] = createSignal<PopoverName>(null);
  const [popoverTrigger, setPopoverTrigger] = createSignal<HTMLElement | undefined>();
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [paletteScope, setPaletteScope] = createSignal<PaletteScope | null>(null);
  const [searchSeed, setSearchSeed] = createSignal<SearchSeed | null>(null);
  const [headerBack, setHeaderBack] = createSignal<(() => void) | null>(null);
  const [placesSlot, setPlacesSlot] = createSignal<HTMLElement | undefined>();
  const [placesAway, setPlacesAway] = createSignal(false);
  const [slim, setSlim] = createSignal(false);
  const [paper, setPaper] = createSignal(false);
  const [backStage, setBackStage] = createSignal<(() => BackStage | null) | null>(null);
  const [listTucked, setListTucked] = createSignal(readListTucked());
  const [pageLevels, setPageLevels] = createSignal<PageLevels | null>(null);
  const [lastNote, setLastNote] = createSignal<Partial<Record<NoteKind, string>>>({});
  const [quickJot, setQuickJot] = createSignal(false);
  const [notePanelPinned, setNotePanelPinned] = createSignal(false);
  const [noteState, setNoteState] = createSignal<NoteState | null>(null);
  const [browseFilter, setBrowseFilter] = createSignal<BrowseFilter>(NO_FILTER);
  const [saveState, setSaveState] = createSignal<SaveState>(IDLE_SAVE);
  const [toast, setToast] = createSignal<Toast | null>(null);
  const [dataVersion, setDataVersion] = createSignal(0);
  const [recordsVersion, setRecordsVersion] = createSignal(0);

  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  const clearToastTimer = (): void => {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = undefined;
    }
  };
  onCleanup(clearToastTimer);

  const shell: Shell = {
    popover,
    togglePopover: (name, trigger) => {
      setPopoverTrigger(trigger);
      setPopover((current) => (current === name ? null : name));
    },
    popoverTrigger,
    closePopovers: () => setPopover(null),
    paletteOpen,
    paletteScope,
    openPalette: (scope) => {
      setPopover(null);
      setPaletteScope(scope ?? null);
      setSearchSeed(null);
      setPaletteOpen(true);
    },
    closePalette: () => setPaletteOpen(false),
    searchSeed,
    openSearch: (seed) => {
      setPopover(null);
      setPaletteOpen(false);
      setSearchSeed((open) => seed ?? open ?? {});
    },
    closeSearch: () => setSearchSeed(null),
    headerBack,
    // A function is a valid signal value only when wrapped: the setter would call it otherwise
    setHeaderBack: (back) => setHeaderBack(() => back),
    placesSlot,
    setPlacesSlot,
    placesAway,
    setPlacesAway,
    slim,
    setSlim,
    paper,
    setPaper,
    backStage,
    // Wrapped, like `headerBack`: the setter would call a bare function
    setBackStage: (stage) => setBackStage(() => stage),
    listTucked,
    setListTucked: (tucked) => {
      setListTucked(tucked);
      rememberListTucked(tucked);
    },
    pageLevels,
    setPageLevels,
    lastNote,
    setLastNote: (kind, filename) => setLastNote((last) => ({ ...last, [kind]: filename })),
    quickJot,
    setQuickJot,
    notePanelPinned,
    setNotePanelPinned,
    noteState,
    setNoteState,
    saveState,
    setSaveState,
    browseFilter,
    setBrowseFilter,
    toast,
    showToast: (message, undo, detail) => {
      clearToastTimer();
      setToast({ message, undo, detail });
      toastTimer = setTimeout(() => setToast(null), TOAST_MS);
    },
    dismissToast: () => {
      clearToastTimer();
      setToast(null);
    },
    dataVersion,
    refreshData: () => setDataVersion((v) => v + 1),
    recordsVersion,
    recordsChanged: () => setRecordsVersion((v) => v + 1),
    onLeave: leaveHandlers.register,
    leave: leaveHandlers.run,
  };

  return <ShellContext.Provider value={shell}>{props.children}</ShellContext.Provider>;
}
