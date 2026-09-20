import { createContext, createSignal, useContext, onCleanup } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import type { PaletteScope } from "./search-scope";
import type { SaveStatus } from "./note-session";

/** ボトムバーに出す保存の様子と、最後に保存できた時刻。 */
interface SaveState {
  status: SaveStatus;
  /** 「22:18」。`status` が `savedAt` のときだけ意味を持つ。 */
  at: string;
}

const IDLE_SAVE: SaveState = { status: "idle", at: "" };

/** 同時に開けるポップオーバーは 1 つだけ。 */
type PopoverName = "sync" | "calendar" | "note-meta" | "note-menu" | "new-note-menu" | null;

interface Toast {
  message: string;
  /** 与えられていれば「元に戻す」を出す。 */
  undo?: () => void;
  /** 本文の横に薄く添える要約。「版 4 から +312 B · 7 日ぶり」 */
  detail?: string;
}

const TOAST_MS = 5000;

export interface Shell {
  popover: Accessor<PopoverName>;
  /**
   * 開けたボタンを渡すと、そのボタンを押したぶんは「外側」に数えなくなる
   * (`components/Popover.tsx`)。先に閉じてしまうと、直後の click がもう一度
   * 開けてしまい、同じボタンでは畳めない。
   */
  togglePopover: (name: Exclude<PopoverName, null>, trigger?: HTMLElement) => void;
  /** いま開いているポップオーバーを開けたボタン。 */
  popoverTrigger: Accessor<HTMLElement | undefined>;
  closePopovers: () => void;
  paletteOpen: Accessor<boolean>;
  /** 開いたときに引き継いだ範囲。無ければ全体を探す。 */
  paletteScope: Accessor<PaletteScope | null>;
  openPalette: (scope?: PaletteScope) => void;
  closePalette: () => void;
  /**
   * レールか一覧フライアウトにポインタが乗っているか。レールは AppLayout に、
   * 一覧は Workspace にあるので、開閉の合図はここで落ち合う。
   */
  listHover: Accessor<boolean>;
  setListHover: (on: boolean) => void;
  /** ピンと ⌘\ で常設にしているか。離れても畳まない。 */
  listPinned: Accessor<boolean>;
  toggleListPin: () => void;
  /** 一覧フライアウトが開いているか。 */
  listOpen: Accessor<boolean>;
  /**
   * 保存の着地。書いているのは `Workspace` で、出すのはボトムバー
   * (`AppLayout`)なので、ここで落ち合う。面を離れたら `idle` に戻す —
   * 持ち越すと、保存していない画面が「22:18 に保存」と言い続ける。
   */
  saveState: Accessor<SaveState>;
  setSaveState: (state: SaveState) => void;
  /**
   * Scrawl で絞り込んでいるタグ。Scrawl の中だけで持つと ⌘K の
   * 処理(AppLayout)から見えないので、ここに引き上げてある。
   */
  scrawlTag: Accessor<string | null>;
  setScrawlTag: (tag: string | null) => void;
  toast: Accessor<Toast | null>;
  showToast: (message: string, undo?: () => void, detail?: string) => void;
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
  const [popoverTrigger, setPopoverTrigger] = createSignal<HTMLElement | undefined>();
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [paletteScope, setPaletteScope] = createSignal<PaletteScope | null>(null);
  const [listHover, setListHover] = createSignal(false);
  const [listPinned, setListPinned] = createSignal(false);
  const [scrawlTag, setScrawlTag] = createSignal<string | null>(null);
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
    saveState,
    setSaveState,
    scrawlTag,
    setScrawlTag,
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
