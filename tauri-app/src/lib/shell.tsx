import { createContext, createSignal, useContext, onCleanup } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import { NO_FILTER } from "./browse";
import type { BrowseFilter } from "./browse";
import type { PaletteScope } from "./search-scope";
import type { SaveStatus } from "./note-session";

/** The save state shown in the bottom bar, and the time of the last successful save. */
interface SaveState {
  status: SaveStatus;
  /** A clock time such as "22:18". It means something only when `status` is `savedAt`. */
  at: string;
}

const IDLE_SAVE: SaveState = { status: "idle", at: "" };

/**
 * What the bottom bar says about the open note besides the save, and the two actions it
 * offers at its right end. The note lives in Workspace and the bar in AppLayout, so they meet
 * here the way the save state does. `null` while no note is open.
 */
export interface NoteBar {
  /** Codex only. "+312 B from version 4" and the like. */
  version?: string;
  /** While comparing with a version. "comparing with version 2 · 3 lines added". */
  comparing?: string;
  readOnly: boolean;
  map: boolean;
  examples: boolean;
  /** Whether "commit a version" is worth offering: a Codex whose draft has moved on. */
  canCommit: boolean;
  /** Whether "back to before this edit" would do anything right now. */
  canRevert: boolean;
  commit: () => void;
  revert: () => void;
  /** Opens the panel pinned on its settings tab. A state in the bar leads to its switch. */
  openSettings: () => void;
  /** Opens the panel pinned on the history tab. */
  openHistory: () => void;
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
  /**
   * Whether the pointer is on the rail or on the list flyout. The rail lives in AppLayout
   * and the list in Workspace, so the open/close signal meets here.
   */
  listHover: Accessor<boolean>;
  setListHover: (on: boolean) => void;
  /** Whether the pin or `⌘\` keeps it out. It does not fold away when the pointer leaves. */
  listPinned: Accessor<boolean>;
  toggleListPin: () => void;
  /** Whether the list flyout is open. */
  listOpen: Accessor<boolean>;
  /**
   * Whether the note's right panel is docked beside the body. Like `listPinned` it belongs to
   * the app, not to one note: opening the next note keeps it where it was.
   */
  notePanelPinned: Accessor<boolean>;
  setNotePanelPinned: (pinned: boolean) => void;
  noteBar: Accessor<NoteBar | null>;
  setNoteBar: (bar: NoteBar | null) => void;
  /**
   * Where the save landed. `Workspace` writes it and the bottom bar (`AppLayout`) shows it,
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
  const [popover, setPopover] = createSignal<PopoverName>(null);
  const [popoverTrigger, setPopoverTrigger] = createSignal<HTMLElement | undefined>();
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [paletteScope, setPaletteScope] = createSignal<PaletteScope | null>(null);
  const [listHover, setListHover] = createSignal(false);
  const [listPinned, setListPinned] = createSignal(false);
  const [notePanelPinned, setNotePanelPinned] = createSignal(false);
  const [noteBar, setNoteBar] = createSignal<NoteBar | null>(null);
  const [browseFilter, setBrowseFilter] = createSignal<BrowseFilter>(NO_FILTER);
  const [saveState, setSaveState] = createSignal<SaveState>(IDLE_SAVE);
  const [toast, setToast] = createSignal<Toast | null>(null);
  const [dataVersion, setDataVersion] = createSignal(0);

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
      setPaletteOpen(true);
    },
    closePalette: () => setPaletteOpen(false),
    listHover,
    setListHover,
    listPinned,
    toggleListPin: () => setListPinned((pinned) => !pinned),
    listOpen: () => listPinned() || listHover(),
    notePanelPinned,
    setNotePanelPinned,
    noteBar,
    setNoteBar,
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
  };

  return <ShellContext.Provider value={shell}>{props.children}</ShellContext.Provider>;
}
