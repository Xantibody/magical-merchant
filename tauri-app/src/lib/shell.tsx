import { createContext, createSignal, useContext, onCleanup } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import type { PaletteScope } from "./search-scope";

/** 同時に開けるポップオーバーは 1 つだけ。 */
type PopoverName = "sync" | "calendar" | "note-meta" | "note-menu" | "new-note-menu" | null;

interface Toast {
  message: string;
  /** 与えられていれば「元に戻す」を出す。 */
  undo?: () => void;
}

const TOAST_MS = 5000;

export interface Shell {
  popover: Accessor<PopoverName>;
  togglePopover: (name: Exclude<PopoverName, null>) => void;
  closePopovers: () => void;
  paletteOpen: Accessor<boolean>;
  /** 開いたときに引き継いだ範囲。無ければ全体を探す。 */
  paletteScope: Accessor<PaletteScope | null>;
  openPalette: (scope?: PaletteScope) => void;
  closePalette: () => void;
  /**
   * Timeline で絞り込んでいるタグ。Timeline の中だけで持つと ⌘K の
   * 処理(AppLayout)から見えないので、ここに引き上げてある。
   */
  timelineTag: Accessor<string | null>;
  setTimelineTag: (tag: string | null) => void;
  toast: Accessor<Toast | null>;
  showToast: (message: string, undo?: () => void) => void;
  dismissToast: () => void;
  /** データを読み直させる合図。増えたら再取得する。 */
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
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [paletteScope, setPaletteScope] = createSignal<PaletteScope | null>(null);
  const [timelineTag, setTimelineTag] = createSignal<string | null>(null);
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
    togglePopover: (name) => {
      setPopover((current) => (current === name ? null : name));
    },
    closePopovers: () => setPopover(null),
    paletteOpen,
    paletteScope,
    openPalette: (scope) => {
      setPopover(null);
      setPaletteScope(scope ?? null);
      setPaletteOpen(true);
    },
    closePalette: () => setPaletteOpen(false),
    timelineTag,
    setTimelineTag,
    toast,
    showToast: (message, undo) => {
      clearToastTimer();
      setToast({ message, undo });
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
