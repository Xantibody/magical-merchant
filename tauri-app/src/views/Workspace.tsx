import {
  createSignal,
  createResource,
  createMemo,
  createEffect,
  on,
  batch,
  For,
  Show,
  lazy,
  onMount,
  onCleanup,
} from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import type { Editor } from "@milkdown/kit/core";
import Drawer from "corvu/drawer";
import HistoryPanel from "../components/HistoryPanel";
import Icon from "../components/Icon";
import KindDot from "../components/KindDot";
import LinkPeek from "../components/LinkPeek";
import MarkdownPreview from "../components/MarkdownPreview";
import NoteList from "../components/NoteList";
import NotePanel from "../components/NotePanel";
import type { NotePanelTab } from "../components/NotePanel";
import NoteStatusRow from "../components/NoteStatusRow";
import NoteStrip from "../components/NoteStrip";
import TagEditor from "../components/TagEditor";
import { createCodexHistory } from "../lib/codex-history";
import { isStaleSave, typedInvoke } from "../lib/commands";
import { resolveEditedTime } from "../lib/note-meta";
import { parseTags } from "../lib/tags";
import { refusedForGood } from "../lib/save-refusal";
import { createNoteBuffer } from "../lib/note-buffer";
import { isWriteKey, noteKeys } from "../lib/note-keys";
import { createNoteMetaEditor } from "../lib/note-meta-editor";
import { createNotePanel } from "../lib/note-panel-state";
import { createNoteSelection } from "../lib/note-selection";
import { createNoteSession } from "../lib/note-session";
import type { SaveStatus } from "../lib/note-session";
import { getDeviceSignals } from "../lib/client-context";
import { createDebouncedAccessor } from "../lib/debounce";
import { glyphs } from "../lib/glyphs";
import { sameEntries } from "../lib/same-entries";
import { examplesShown, extractExamples, setExamplesShown } from "../lib/template-examples";
import { useShell } from "../lib/shell";
import { groupNotes, neighborOf, noteCreatedLabel, stepNote, toNoteItems } from "../lib/items";
import type { ItemGroup, NoteItem } from "../lib/items";
import { readNoteContent, viewToFrontmatter } from "../lib/note-view";
import type { NoteView } from "../lib/note-view";
import { splitTitle } from "../lib/note-title";
import { formatClock, formatMonthDay } from "../lib/day-labels";
import { locale, t } from "../lib/i18n";
import { isImeComposing } from "../lib/ime";
import { isTypingTarget, matchesShortcut } from "../lib/shortcuts";
import { versionStatusLabel } from "../lib/versions";
import { readBackup, writeBackup } from "../lib/edit-backup";
import { claimsSelectAll, selectContents } from "../lib/select-all";
import { gapAt, placeCaret, placeCaretAfter, startsWriting, tapSpot } from "../lib/tap-to-write";
import { settleOpenedLine } from "../lib/opened-line";
import type { OpenedLine } from "../lib/opened-line";
import type { DropSpot, TapSpot } from "../lib/tap-to-write";
import { createRingPress } from "../components/Ring";
import type { DropTarget } from "../components/Ring";
import type { NoteLinkTarget } from "../lib/note-link-plugin";
import type { NoteKind, SearchHit, Template } from "../lib/commands";
import { noteRoute, writeRoute } from "../lib/note-route";
import { ROUTES } from "../lib/routes";
import "../styles/workspace.css";

/**
 * Where a phone's note sheet stops (29): a little (the title, the tags, a Codex's version and
 * the compare line, over a body still read above it), half (the view switches and the details
 * too), all of it (the rare actions, the history). Pixels for the first so it holds the same
 * rows on every phone; fractions of the sheet's height for the rest.
 */
type SheetPoint = `${number}px` | number;
const SHEET_POINTS: SheetPoint[] = [0, "196px", 0.55, 1];
const SHEET_LITTLE: SheetPoint = "196px";
const SHEET_HALF = 0.55;

/**
 * How much of the sheet a stop leaves on screen, as CSS: the sheet's own height is
 * note-panel.css's `.note-sheet` (88dvh less the top inset), and a fraction stop shows that
 * share of it. The panel inside takes this height, so its foot row stands at the visible foot
 * and what does not fit scrolls, at every stop.
 */
function sheetStopHeight(point: SheetPoint): string {
  if (typeof point === "string") {
    return point;
  }
  return `calc((88dvh - var(--safe-top)) * ${point})`;
}

// Milkdown + ProseMirror is not needed until the detail opens. A screen that only shows the list
// stays clear of that weight (on a narrow device list and detail swap, so it waits for an open)
const MilkdownEditor = lazy(() => import("../components/MilkdownEditor"));
const MarkdownToolbar = lazy(() => import("../components/MarkdownToolbar"));
// markmap-view drags d3 along. It is not loaded until a note turned into a mindmap is opened
const MindmapView = lazy(() => import("../components/MindmapView"));

const UNDO_MS = 5000;
/** How long "saved" stays up. Past that it falls back to showing the save time. */
const SAVED_MS = 2000;
/** How long the map alongside takes to catch up with typing. It catches up before the save (1 s). */
const MAP_DEBOUNCE_MS = 300;
/** The empty table a note with no examples passes. Recreating it redraws the plugin every time. */
const NO_EXAMPLES: ReadonlyMap<string, string[]> = new Map();

async function loadNotes(): Promise<NoteItem[]> {
  return toNoteItems(await typedInvoke("list_notes"));
}

/** The records that point at this note, under the body in the viewer. */
function Backlinks(props: { hits: SearchHit[]; onOpen: (hit: SearchHit) => void }): JSX.Element {
  return (
    <Show when={props.hits.length > 0}>
      <section class="backlinks">
        <h2 class="backlinks-summary">{t().viewer.pointedFrom}</h2>
        <div class="backlinks-list">
          <For each={props.hits}>
            {(hit) => (
              <button type="button" class="backlink-row" onClick={() => props.onOpen(hit)}>
                <KindDot kind={hit.kind} />
                <span class="backlink-title">{hit.title || hit.snippet}</span>
                <span class="backlink-date">{formatMonthDay(hit.date)}</span>
              </button>
            )}
          </For>
        </div>
      </section>
    </Show>
  );
}

/**
 * The map laid to the right of the body. Rebuilding the diagram on every keystroke would keep the
 * branches jumping beside the writing, so it catches up once the hand stops.
 */
function NoteMap(props: { source: () => string }): JSX.Element {
  const source = createDebouncedAccessor(props.source, MAP_DEBOUNCE_MS);
  return (
    <aside class="detail-map" aria-label={t().notes.map}>
      {/* A mindmap's root is the H1. Passing the body with the title taken off
          gives a diagram of branches with no root */}
      <MindmapView source={source()} />
    </aside>
  );
}

interface WorkspaceProps {
  /** Which surface. The same screen serves both `/notes` and `/codex`. */
  kind?: NoteKind;
}

/**
 * What the meta line shows. Nothing in it can be pressed or edited. A tag written in the body
 * is told apart by its outline alone.
 */
function metaLine(item: NoteItem, bodyTags: ReadonlySet<string>): JSX.Element {
  return (
    <>
      <span>{noteCreatedLabel(item)}</span>
      <For each={item.tags}>
        {(tag) => (
          <span class="meta-tag" classList={{ "meta-tag--body": bodyTags.has(tag) }}>
            #{tag}
          </span>
        )}
      </For>
    </>
  );
}

export default function Workspace(props: WorkspaceProps): JSX.Element {
  const kind = (): NoteKind => props.kind ?? "note";
  const shell = useShell();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const today = new Date();

  const [detailOpen, setDetailOpen] = createSignal(false);
  const [saveStatus, setSaveStatus] = createSignal<SaveStatus>("idle");
  /** The time of the last save that succeeded. The number in "saved at 21:40". */
  const [savedAt, setSavedAt] = createSignal("");

  // The save state also shows on the status dot (AppLayout). That sits outside this screen, so it
  // is passed through the shell. Leaving resets it to idle: carried over, a screen nobody is
  // writing on would keep saying "saved at 21:40"
  createEffect(() => shell.setSaveState({ status: saveStatus(), at: savedAt() }));
  onCleanup(() => shell.setSaveState({ status: "idle", at: "" }));
  const [hidden, setHidden] = createSignal<string[]>([]);
  /** The open note's title, body and mode as the screen holds them (`lib/note-buffer.ts`). */
  const buffer = createNoteBuffer();
  const {
    body: noteBody,
    setBody: setNoteBody,
    title: noteTitle,
    setTitle: setNoteTitle,
    view: noteView,
    setView: setNoteView,
    loadedId,
    epoch: bodyEpoch,
    full: fullBody,
  } = buffer;
  /** Whether the tags on the meta line (or the phone's panel) are being edited. */
  const [tagEditing, setTagEditing] = createSignal(false);
  /** What a touch device's toolbar acts on. undefined while no note is open. */
  const [markdownEditor, setMarkdownEditor] = createSignal<Editor | undefined>();

  const [notes, { refetch: refetchNotes }] = createResource(loadNotes);
  // It does not open until "new" is pressed, but starting the read at that moment draws an empty
  // menu once. There are only a few of them, so fetching them with the list costs nothing visible
  const [templates, { refetch: refetchTemplates }] = createResource(() =>
    typedInvoke("list_templates"),
  );

  let detailBodyRef: HTMLDivElement | undefined;
  let workspaceRef: HTMLDivElement | undefined;
  let detailPaneRef: HTMLDivElement | undefined;
  let gripHostRef: HTMLDivElement | undefined;
  let peekRef: HTMLDivElement | undefined;
  /** Where the phone's sheet stands (29). */
  const [sheetPoint, setSheetPoint] = createSignal<SheetPoint>(SHEET_HALF);
  /** The reading page drawn under the writing one while a finger slides writing away (61). */
  const [peekReading, setPeekReading] = createSignal(false);
  /** A note a `[[link]]` points at, lifted over this one (88). */
  const [peekFile, setPeekFile] = createSignal<string | null>(null);
  /** The timer that drops "saved" down to showing the save time. */
  let savedTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * The sign that a save landed. Leaving the green "saved" up would light the edge of vision the
   * whole time someone is writing. Show it for 2 seconds, then let it settle into the time.
   */
  const markSaved = (): void => {
    clearTimeout(savedTimer);
    batch(() => {
      setSavedAt(formatClock(new Date()));
      setSaveStatus("saved");
    });
    savedTimer = setTimeout(() => setSaveStatus("savedAt"), SAVED_MS);
  };

  /**
   * Whether the width has list and detail side by side. On a narrow device the body is not on
   * screen until the detail opens, so starting Milkdown there would make someone who is only
   * looking at the list load the whole of ProseMirror.
   */
  const wideEnough = globalThis.matchMedia("(min-width: 768px)");
  const [twoPane, setTwoPane] = createSignal(wideEnough.matches);
  const onWidthChange = (e: MediaQueryListEvent): void => {
    setTwoPane(e.matches);
  };
  wideEnough.addEventListener("change", onWidthChange);
  onCleanup(() => wideEnough.removeEventListener("change", onWidthChange));

  /** Whether the body is actually on screen. While it is not, no editor is built either. */
  const bodyVisible = createMemo<boolean>(() => twoPane() || detailOpen());

  // The list brings both stores in at once. Narrowing by surface happens here: rather than one IPC
  // call per surface, it is better to hold all of them so `?file=` knows where to send you
  const allItems = createMemo<NoteItem[]>(() => {
    const dropped = new Set(hidden());
    return (notes() ?? []).filter((item) => !dropped.has(item.id));
  });
  const visibleItems = createMemo<NoteItem[]>(() =>
    allItems().filter((item) => item.kind === kind()),
  );

  /**
   * Which surface the target of an entry that knows only an ID (`?file=`, `[[link]]`, a backlink)
   * lives on. It cannot be known before the list arrives, hence undefined.
   */
  const kindOf = (filename: string): NoteKind | undefined =>
    notes()?.find((item) => item.filename === filename)?.kind;

  const groups = createMemo<ItemGroup[]>(() => groupNotes(visibleItems(), today));

  /** The note being looked at, and whether the body on screen is its (`lib/note-selection.ts`). */
  const { setSelectedId, selected, selectedKey, loaded } = createNoteSelection(
    visibleItems,
    loadedId,
  );

  /** The open Codex's versions and compare mode (`lib/codex-history.ts`). */
  const codexHistory = createCodexHistory({
    kind,
    selected: () => selected(),
    loaded: () => loaded(),
    body: () => fullBody(),
    refreshList: () => refetchNotes(),
    showToast: (text, undo, detail) => shell.showToast(text, undo, detail),
  });
  const {
    open: historyOpen,
    setOpen: setHistoryOpen,
    selectedVersionId,
    setSelectedVersionId,
    freshId: freshVersionId,
    status: versionStatus,
    rows: versionRows,
    marked,
    cadence,
    selectedRow,
    compareDetail,
    compareLine,
    canCommit,
    refetchStatus: refetchVersionStatus,
    refresh: refreshVersions,
    leave: leaveHistory,
  } = codexHistory;

  /**
   * Whether the note is open to write (ADR 0003). A record opens in the viewer and is written
   * only after Enter, e or a double click, so nothing is rewritten by accident and the
   * read-only lock has nothing left to guard (ADR 0004). The URL carries it, so back and
   * forward move between the two as well. `view: preview` in the frontmatter is left as written
   * and now means what every note does: it opens in the viewer.
   */
  const writing = createMemo<boolean>(() => searchParams.edit === "1");

  /** Whether the map is laid alongside. The same `view` key remembers it as `mindmap`. */
  const mapOpen = createMemo<boolean>(() => noteView() === "mindmap");
  /** A version is compared without the map. */
  const mapShown = (): boolean => mapOpen() && !historyOpen();

  /**
   * Whether a phone is reading: then the title and its lines are the top of the scrolling page
   * rather than a block pinned over it, and scroll away as the text is read (4). Not with the
   * map up: a phone swaps the body for the map, and the title would go with it.
   */
  const headInBody = (): boolean => !twoPane() && !writing() && !mapShown();

  /**
   * The tags written in the body as `#tag`. The meta line tells them from the frontmatter's
   * by an outline alone: they are edited where they are written, not in the panel.
   */
  const bodyTags = createMemo<ReadonlySet<string>>(() => new Set(parseTags(fullBody())));

  /**
   * The table that resolves `[[ID]]` to a title. The preview looks it up every time it draws.
   * It is not narrowed by surface: a note moved from Note to Codex is still pointed at by the same
   * ID, and opening it sends you to the other surface.
   *
   * The list is reread on every return to the window. A rebuilt table with the same titles is
   * dropped, so the preview does not draw the whole body again for nothing.
   */
  const noteTitles = createMemo(
    (): ReadonlyMap<string, string> =>
      new Map(allItems().map((item) => [item.filename.replace(/\.md$/u, ""), item.title])),
    undefined,
    { equals: sameEntries },
  );

  /** The candidates for `[[` completion. From both surfaces. A link to itself is not offered. */
  const linkTargets = (): NoteLinkTarget[] =>
    allItems()
      .filter((item) => item.id !== selected()?.id)
      .map((item) => ({ id: item.filename.replace(/\.md$/u, ""), title: item.title }));

  /**
   * A template's examples. Only a note born from a template looks them up.
   *
   * They are never written into the note's file, so they cannot be read from the body: the only
   * way is to read the template its origin (`template:`) names again. If that cannot be read,
   * nothing is shown: someone who deleted a template is not shown what they deleted.
   */
  const [templateExamples] = createResource(
    () => (examplesShown() ? selected()?.template : undefined),
    async (name) => {
      try {
        const detail = await typedInvoke("read_template", { filename: `${name}.md` });
        return extractExamples(detail.body);
      } catch {
        return new Map<string, string[]>();
      }
    },
  );
  // createResource keeps holding its last value even after the source goes undefined, so whether
  // they are folded away is checked once more here
  const examples = (): ReadonlyMap<string, string[]> =>
    examplesShown() ? (templateExamples() ?? NO_EXAMPLES) : NO_EXAMPLES;

  // The records that point at this note with [[ID]]. Derived by a scan each time it is opened
  const [backlinks] = createResource(
    () => selected()?.filename,
    (filename) => typedInvoke("find_backlinks", { filename }),
  );

  /** Where the note panel stands and what is open in it (`lib/note-panel-state.ts`). */
  const panel = createNotePanel({
    twoPane,
    writing,
    historyOpen,
    pinned: () => shell.notePanelPinned(),
    setPinned: (pinned) => shell.setNotePanelPinned(pinned),
    leaveHistory,
  });
  const {
    setScreen: setPanelScreen,
    screenShown: panelScreenShown,
    open: panelOpen,
    tab: panelTab,
    detailsOpen,
    setDetailsOpen,
    close: closePanel,
    toggle: togglePanel,
  } = panel;

  /** The frontmatter the panel edits: own tags, created time (`lib/note-meta-editor.ts`). */
  const {
    meta: currentMeta,
    failed: metaFailed,
    save: saveMeta,
    restoreTag,
  } = createNoteMetaEditor({
    active: () => panelScreenShown() || panelOpen(),
    selected: () => selected(),
    refreshList: () => refetchNotes(),
    showToast: (text) => shell.showToast(text),
  });

  /**
   * Tags used anywhere, most used first: the suggestions under the tag input. Counted in core
   * over the same records Browse reads, and only once the tags are pressed.
   */
  const [usedTags] = createResource(
    () => tagEditing() || undefined,
    async () => {
      try {
        const used = await typedInvoke("count_tags");
        return used.map((usage) => ({ tag: usage.tag, count: usage.notes + usage.entries }));
      } catch {
        // Without suggestions a tag can still be typed in full
        return [];
      }
    },
  );

  /**
   * Whether to show the compare bar. While compare mode is on, on a phone with the sheet put away. It shows even when the
   * chosen version has the same content: without it there is no way back to the history and no way
   * to leave compare mode.
   */
  const compareBarOpen = (): boolean =>
    kind() === "codex" && historyOpen() && !panelScreenShown() && !twoPane();

  /**
   * Replaces the whole body on screen. The editor holds its own document as the truth, so anything
   * that comes through here rebuilds it (`bodyEpoch`). Sending the pieces separately would draw a
   * moment in the wrong mode, so title, body and mode are set at once.
   */
  const showBody = (id: string, title: string, body: string, view: NoteView): void => {
    // The 2 seconds of "saved" belong to the previous note. Carried over, a note that was not
    // saved would show "saved at 21:40"
    clearTimeout(savedTimer);
    batch(() => {
      buffer.show(id, title, body, view);
      setSaveStatus("idle");
    });
  };

  /**
   * The mediation between the body on disk and the screen (`lib/note-session.ts`). Reading, the
   * revision, autosave and the backup taken on a refusal are all decided there. The screen holds
   * only how things are shown.
   */
  const session = createNoteSession({
    selected: () => selected(),
    loaded: () => loaded(),
    body: () => fullBody(),
    bodyEpoch,
    bodyHasFocus: () => Boolean(detailBodyRef?.contains(document.activeElement)),
    store: localStorage,
    read: (filename) =>
      readNoteContent(
        () => typedInvoke("read_note", { filename }),
        () => typedInvoke("read_note_meta", { filename }),
      ),
    write: async (filename, body, revision) =>
      typedInvoke("update_draft", {
        filename,
        body,
        client: await getDeviceSignals(),
        revision,
      }),
    showBody,
    showView: setNoteView,
    refreshList: () => refetchNotes(),
    setStatus: (status) => {
      // A failure must outlive the 2 seconds of "saved" still counting down from the last save
      clearTimeout(savedTimer);
      setSaveStatus(status);
    },
    onSaved: () => {
      markSaved();
      // "+X B from version N" compares the newest version with the draft. Every write changes it
      if (kind() === "codex") {
        void refetchVersionStatus();
      }
    },
    showToast: (text) => shell.showToast(text),
  });

  // ---- read the selected note's body and view mode ----
  // What is followed is only "which note is being looked at". Following the item itself would
  // reread the body on every refetch of the list, swapping the body under an open editor
  createEffect(
    on(selectedKey, () => {
      const item = selected();
      // Moving to another note folds the edit session. If the place to return to stayed the
      // previous note's body, the next save would crush another note's backup
      session.drop();
      // The history and the half-typed tag belong to the note that was open. Whether the
      // panel is docked does not: that is the app's, like the list's tuck
      setHistoryOpen(false);
      setSelectedVersionId(null);
      setTagEditing(false);
      if (!item) {
        showBody("", "", "", "editor");
        return;
      }
      // Until it arrives it is "nobody's body yet". Fold the previous note's editor and make the
      // title unwritable too. Standing it up once after the body arrives is lighter than standing
      // an empty editor first and rebuilding it with the body
      buffer.unload();
      // Opening another note is the person's intent. The pending save has already been flushed by
      // `settleEdit`, so it is fine to give way even with the cursor still in the body
      void session.reload(item, true);
    }),
  );

  /**
   * Remembers the view mode. `view` is a single key, so read-only and the map are never both
   * up: whichever was pressed later stays.
   */
  const setView = async (item: NoteItem, next: NoteView): Promise<void> => {
    const previous = noteView();
    // Switch without waiting for the write. The write can fail on a note with broken frontmatter,
    // and in that case only the display is put back
    setNoteView(next);
    shell.closePopovers();
    try {
      await typedInvoke("set_note_view", {
        filename: item.filename,
        view: viewToFrontmatter(next),
      });
      await refetchNotes();
    } catch {
      setNoteView(previous);
    }
  };

  /** Viewer → writing. Replaces the entry, so back leaves the note rather than the mode. */
  const startWriting = (): void => {
    if (selected() && !historyOpen()) {
      setSearchParams({ edit: "1" }, { replace: true });
    }
  };

  /** Writing → viewer. The save is automatic, so there is no "save and close". */
  const stopWriting = (): void => {
    void session.settleEdit();
    setSearchParams({ edit: undefined }, { replace: true });
  };

  /** A record chosen from the list opens in the viewer, whichever note was being written. */
  const openInViewer = (): void => {
    if (writing()) {
      stopWriting();
    }
  };

  const toggleMap = (item: NoteItem): Promise<void> =>
    setView(item, mapOpen() ? "editor" : "mindmap");

  // Leaving the app writes the save still waiting on its debounce. On Android the process
  // may be gone before the timer fires
  onCleanup(shell.onLeave(() => session.settleEdit()));

  onCleanup(() => {
    clearTimeout(savedTimer);
    session.dispose();
  });

  // Refetch the data after a sync or a palette action. createResource does the first read, so
  // without defer every note would be reread twice right after mount
  createEffect(
    on(
      shell.dataVersion,
      () => {
        void refetchNotes();
        void refetchTemplates();
        // Refetching the list alone leaves a note that stays open showing its old body. What came
        // down through sync is reread here. It only reads; it never writes back
        const item = selected();
        // Never touch it while someone is writing. Replacing the body destroys the cursor, the
        // selection, the scroll and the IME state (editor skill). The same holds while a save is
        // pending: what was typed is not on disk yet, so rereading would throw it away.
        // For both, the next Step (file watching) raises a toast and lets the person decide
        if (item && !session.isTyping()) {
          void session.reload(item);
        }
        // Versions grow through sync too. The filename is the same, so the resource does not
        // refetch by itself
        if (kind() === "codex") {
          refreshVersions();
        }
      },
      { defer: true },
    ),
  );

  /**
   * The one entry that replaces the selection. A tap in the list, a widget's `?file=`, creating a
   * new note, a template and a backlink all come through here. Writing "what to do if an edit is
   * under way" at each entry would let the one entry it was forgotten at carry the previous note's
   * body into the next note. However many entries appear, it stays written in one place.
   */
  async function switchTo(id: string): Promise<void> {
    await session.settleEdit();
    setSelectedId(id);
    setDetailOpen(true);
  }

  const select = (item: NoteItem): void => {
    shell.closePopovers();
    openInViewer();
    void switchTo(item.id);
  };

  /**
   * Opens the note an ID points at. If it lives on another surface, send there: selecting an id
   * that is not in this surface's list would only fall back to the first note.
   */
  const openFile = async (filename: string): Promise<void> => {
    const other = kindOf(filename);
    if (other && other !== kind()) {
      navigate(noteRoute(other, filename));
      return;
    }
    await switchTo(filename);
  };

  const openBacklink = (hit: SearchHit): void => {
    if (hit.kind !== "scrawl" && hit.filename) {
      void openFile(hit.filename);
    } else {
      navigate(`${ROUTES.SCRAWL}?day=${hit.date}`);
    }
  };

  // Only when arriving from a widget row with `?file=`, open that one note. It can arrive before
  // the list does, but the id is the filename itself, so it can be set in advance
  createEffect(
    on(
      () => searchParams.file,
      (file) => {
        if (typeof file === "string" && file) {
          void switchTo(file);
        }
      },
    ),
  );

  // A widget or a `[[link]]` knows only the ID and lands on `/notes?file=`. If the target is a
  // Codex, replace it with `/codex?file=` once the list arrives. The note does not live on this
  // surface, so leaving it in the history would not make it a place to go back to
  createEffect(() => {
    const { file } = searchParams;
    if (typeof file !== "string" || !file) {
      return;
    }
    const other = kindOf(file);
    if (other && other !== kind()) {
      navigate(noteRoute(other, file), { replace: true });
    }
  });

  /** Puts the cursor in the body. A note just promoted is handed over ready to write in. */
  const focusBody = (): void => {
    detailBodyRef?.querySelector<HTMLElement>(".ProseMirror")?.focus();
  };

  /**
   * The title is the H1 at the top of the body itself. Every keystroke rides the same autosave as
   * the body.
   */
  const editTitle = (value: string): void => {
    if (!loaded()) {
      return;
    }
    session.ensure();
    setNoteTitle(value);
    session.schedule();
  };

  /**
   * Leaving the title field flushes the pending save and rereads the list once. The title shown
   * in a row is derived from the first line of the body, so without the reread only the list
   * would be left with the old title.
   */
  const commitTitle = async (): Promise<void> => {
    session.cancelPending();
    // AIDEV-NOTE: a fresh copy, not the one the timer held. The blur comes while this note is
    // still on screen, and the copy must carry the characters just typed into the title field
    await session.flush();
    await session.refreshListIfStale();
  };

  /**
   * Where the tap that opened the writing screen landed. `undefined` when the screen was opened
   * another way (Enter, e, the pencil, a new note): the caret then goes where the editor puts it.
   */
  let tapped: TapSpot | null | undefined;
  /**
   * Where a drop asked the writing screen about to open to start (7): a new line after that
   * block or item, or after the body's last for `null`, as Enter there would open it.
   * `undefined` when the screen was not opened by a drop.
   */
  let dropped: DropSpot | null | undefined;
  /**
   * The line a drop opened, still empty (`lib/opened-line.ts`). Until the body reads otherwise
   * nothing is saved; leaving the writing screen drops it with the editor, and the viewer reads
   * the body as it was.
   */
  let openedLine: OpenedLine | undefined;

  /** Writes from a dropped spot, or the body's end for `null`, on a line of its own (7). */
  const writeAt = (spot: DropSpot | null): void => {
    dropped = spot;
    startWriting();
  };

  /**
   * Where a carried pencil or + lands on the page being read (7): the gap between the two
   * blocks it is let go between, drawn as a line across the column. Off the page, or while the
   * page is not the viewer, nothing takes it.
   */
  const pageTargetAt = (x: number, y: number): DropTarget | null => {
    const body = detailBodyRef;
    const preview = body?.querySelector<HTMLElement>(":scope > .markdown-preview");
    if (!body || !preview || writing() || historyOpen() || !selected()) {
      return null;
    }
    const area = body.getBoundingClientRect();
    if (x < area.left || x > area.right || y < area.top || y > area.bottom) {
      return null;
    }
    const gap = gapAt(preview, y);
    if (!gap) {
      return null;
    }
    const column = preview.getBoundingClientRect();
    return {
      label: t().reach.dropInPage,
      line: { left: column.left, top: gap.y, width: column.width },
      drop: () => writeAt(gap.spot),
    };
  };

  /** The + let go on a row (7): that note, open to write on a fresh last line. */
  const appendTo = async (item: NoteItem): Promise<void> => {
    shell.closePopovers();
    openInViewer();
    // Settled first: the line must open in this note's editor, not the one being left
    await switchTo(item.id);
    writeAt(null);
  };

  /**
   * A phone's pencil (7): tapped it writes, as ever; pressed and slid, it is carried into the
   * page and let go between two blocks to write from there.
   */
  const pencil = createRingPress({
    choices: () => [],
    holdMs: 0,
    carry: () => ({ icon: "pencil", label: t().reach.dragPencil, targetAt: pageTargetAt }),
  });

  const onBodyClick = (e: MouseEvent): void => {
    const target = e.target instanceof Element ? e.target : null;
    const noteLink = target?.closest("a.note-link");
    if (noteLink instanceof HTMLElement && noteLink.dataset.file) {
      // Lifted beside this note, not opened in its place (88): read it, then open or put it away
      setPeekFile(noteLink.dataset.file);
      return;
    }
    // One tap on the page writes, at the spot it landed (R3). What answers a tap itself (links,
    // checkboxes, code copy, diagrams) keeps it; a drag that selected text stays a selection.
    // A phone's head scrolls inside the page, but its title and lines are not the text
    if (
      !writing() &&
      !historyOpen() &&
      target &&
      !target.closest(".detail-head") &&
      startsWriting(e)
    ) {
      const preview = detailBodyRef?.querySelector(".markdown-preview");
      tapped = preview ? tapSpot(preview, e.clientX, e.clientY, target) : null;
      startWriting();
    }
  };

  /**
   * Swaps the "body before the edit" left on this device with the current body. Being a swap,
   * pressing again puts it back: what it returns to is always exactly one step.
   *
   * On a note that cannot be written to disk, the swap is dropped and the backup is only shown on
   * screen. The reasons a backup exists (a corrupt record, a deleted note, a file that cannot be
   * read as text) are the same reasons a write is refused, so showing it only when the write
   * succeeded would leave the backup sitting there with no way anywhere to get it out. On screen,
   * a person can select it and copy it.
   */
  const revertEdit = async (item: NoteItem): Promise<void> => {
    const backup = readBackup(localStorage, item.filename);
    const current = fullBody();
    // Before it arrives, the body on screen is the previous note's. It must not become the backup.
    // While comparing, the body on screen is a version's
    if (!loaded() || historyOpen() || backup === null || backup === current) {
      return;
    }
    // Same rule as the autosave (`flush`): a write with no revision would land on a body nobody
    // here has read. Nothing on screen has changed yet, so the pending save is left to run
    const read = session.revisionOf(item.filename);
    if (read === undefined) {
      shell.showToast(t().notes.revertFailed);
      return;
    }
    // Drop the pending save. The body now on screen is about to become the backup, so there is no
    // point going to disk to write the same thing again
    session.cancelPending();
    let written = true;
    try {
      const revision = await typedInvoke("update_draft", {
        filename: item.filename,
        body: backup,
        client: await getDeviceSignals(),
        revision: read,
      });
      session.setRevision(item.filename, revision);
    } catch (error) {
      // On a note writable after a reread (Stale, a temporary failure), end without showing it.
      // Disk and screen would silently diverge, and the next save crushes the body with the backup
      if (!refusedForGood(error)) {
        shell.showToast(t().notes.revertFailed);
        return;
      }
      written = false;
    }
    if (written) {
      // After the swap, the current "place to return to" is the body from before it. When the
      // write failed there is no swap: the backup is still the only copy of those characters,
      // and every press can bring out the same thing
      writeBackup(localStorage, item.filename, current);
    }
    // Reopen as a session that has finished taking the backup
    session.reopenAt(item.filename, backup);
    const titled = splitTitle(backup);
    // Rebuild the editor itself. Inserting would not put the reverted body on screen
    showBody(item.id, titled.title, titled.body, noteView());
    shell.closePopovers();
    if (written) {
      // A row's title is derived from the body's first line; with no write it has not changed.
      // On a deleted note the whole row goes here, and the backup just shown drops off the screen
      await refetchNotes();
    }
    shell.showToast(written ? t().notes.reverted : t().notes.shownFromBackup);
  };

  /** Commits the current draft as a version (`codexHistory.commit`). */
  const commitVersion = async (item: NoteItem): Promise<void> => {
    if (kind() !== "codex" || !loaded()) {
      return;
    }
    shell.closePopovers();
    // The body on disk is committed. Unless the in-flight save lands, the last typing misses it
    await session.settleWrites();
    await codexHistory.commit(item);
  };

  /**
   * Flush the pending save before the history opens. The history is the screen that compares the
   * body on disk with a version, and "restore" also commits the body on disk as "before the
   * restore": opening while keystrokes exist only on screen loses them into neither. The version
   * chosen the moment it opens is the newest one.
   *
   * On a phone it is the panel screen's second tab.
   */
  const openHistory = async (): Promise<void> => {
    shell.closePopovers();
    if (kind() !== "codex") {
      return;
    }
    openInViewer();
    panel.show();
    if (historyOpen()) {
      return;
    }
    await session.settleWrites();
    await codexHistory.enter();
  };

  /**
   * Opens the panel on its settings tab, docked. A state in the dot's details leads to its switch
   * this way, and ⌘⇧I to the details.
   */
  const openSettings = (details = false): void => {
    openInViewer();
    batch(() => {
      leaveHistory();
      if (details) {
        setDetailsOpen(true);
      }
      panel.show();
    });
  };

  const selectTab = (tab: NotePanelTab): void => {
    if (tab === "history") {
      void openHistory();
    } else {
      leaveHistory();
    }
  };

  /** ⌘⇧H. The same key folds it, so whoever opened it does not hunt for the way out. */
  const toggleHistory = (): void => {
    if (historyOpen()) {
      closePanel();
      return;
    }
    void openHistory();
  };

  /**
   * Makes a version's body the draft. core commits "before the restore" first, so the restore
   * itself can be undone from the history too. The write goes through the same check as
   * `update_draft`, so if it was rewritten outside after the read, it gives way by the same path.
   */
  const restoreVersion = async (item: NoteItem, id: string): Promise<void> => {
    if (!loaded()) {
      return;
    }
    // The revision from when the body on screen was read. Where to fall back if the reread misses.
    // Without one the restore would write over a draft nobody here has read, so it is not sent
    const read = session.revisionOf(item.filename);
    if (read === undefined) {
      shell.showToast(t().codex.restoreFailed);
      return;
    }
    // Drop the pending save. What is restored is the body on disk; keystrokes on screen do not go
    // into the "before the restore" version, but settleEdit already ran when the history opened
    session.cancelPending();
    try {
      const revision = await typedInvoke("restore_note_version", {
        filename: item.filename,
        id,
        client: await getDeviceSignals(),
        revision: read,
      });
      session.setRevision(item.filename, revision);
    } catch (error) {
      if (isStaleSave(error)) {
        await session.yieldToOutsideEdit(session.snapshotFor(item), error);
      } else {
        shell.showToast(t().codex.restoreFailed);
      }
      return;
    }
    // The restored body is on disk. Rereading makes the screen show it too
    session.drop();
    closePanel();
    const shown = await session.reload(item, true);
    if (!shown) {
      // The reread did not reach the screen. The restored body is on disk, but the screen still
      // shows the body from before the restore. Leaving the revision alone at the post-restore one
      // would let the next keystroke's save slip past core's check and silently crush the version
      // just restored.
      // Put the revision back to "the one from when the body on screen was read" and keep the pair
      // intact. The next save is refused as Stale, what was typed is set aside as a backup, and the
      // reread runs once more (`yieldToOutsideEdit`).
      // AIDEV-NOTE: stopping the edit (dropping `loadedId`) was rejected. Riding the existing Stale path, which sets aside what was typed, loses less
      session.setRevision(item.filename, read);
    }
    await refetchNotes();
    refreshVersions();
    shell.showToast(shown ? t().codex.restored : t().codex.restoredNotShown);
  };

  /** The note the cursor was last handed to. Once per opening, not on every reload. */
  let focusedFor: string | undefined;

  // Entering the writing screen (a promotion, a new note, Enter in the viewer) hands the note
  // over ready to write in as soon as the body arrives
  createEffect(() => {
    if (!writing()) {
      focusedFor = undefined;
      openedLine = undefined;
      return;
    }
    const item = selected();
    if (!item || loadedId() !== item.id || focusedFor === item.id) {
      return;
    }
    // When the body arrives there is still nowhere to put it. The editor is loaded lazily and
    // ProseMirror's DOM appears only after create. It is rebuilt together with the body
    // (`bodyEpoch`), so what is visible here is only the editor of the current body
    if (!markdownEditor()) {
      return;
    }
    focusedFor = item.id;
    const editor = detailBodyRef?.querySelector<HTMLElement>(".ProseMirror");
    const ready = markdownEditor();
    if (editor && ready && dropped !== undefined) {
      // A drop asked for a line of its own there (7). The editor's module is already loaded (it
      // is on screen), so this import costs nothing; static, it would pull ProseMirror into the
      // list's chunk
      placeCaretAfter(editor, dropped);
      void (async () => {
        const { openLineAtCaret } = await import("../lib/open-line");
        requestAnimationFrame(() => {
          // The editor reports the change only after its debounce, so the line is known as
          // empty before the first report of it arrives
          const empty = openLineAtCaret(ready);
          openedLine = empty === undefined ? undefined : { id: item.id, empty };
        });
      })();
    } else if (editor && tapped !== undefined) {
      placeCaret(editor, tapped);
    } else {
      focusBody();
    }
    tapped = undefined;
    dropped = undefined;
  });

  // ⌘A in the writing screen selects the body, with the caret brought back if a press on the
  // strip or the margin took it out (`lib/select-all.ts`). In the editor and the title field
  // the key never reaches here as ours: those select their own text. The viewer's ⌘A is the
  // page's own; workspace.css leaves the controls around the note out of it
  onMount(() => {
    const onSelectAll = (e: KeyboardEvent): void => {
      const editor = detailBodyRef?.querySelector<HTMLElement>(".ProseMirror");
      if (!writing() || !editor || !claimsSelectAll(e)) {
        return;
      }
      e.preventDefault();
      editor.focus();
      selectContents(editor);
    };
    globalThis.addEventListener("keydown", onSelectAll);
    onCleanup(() => globalThis.removeEventListener("keydown", onSelectAll));
  });

  const revertable = createMemo<boolean>(() => {
    const item = selected();
    if (!item) {
      return false;
    }
    const backup = readBackup(localStorage, item.filename);
    return backup !== null && backup !== fullBody();
  });

  /**
   * Whether "back to before this edit" would do something now. While comparing, the body on
   * screen is a version's, not the draft.
   */
  const canRevert = (): boolean => revertable() && !historyOpen();

  /** Why revert cannot be pressed, said under the row. Comparing already says it on its own. */
  const revertHint = (): string | undefined => {
    if (historyOpen()) {
      return undefined;
    }
    return revertable() ? undefined : t().notes.revertNeedsEdit;
  };

  // The dot's details (AppLayout) say what state the note is in, so a closed panel hides nothing.
  // Leaving the surface clears it, the way the save state is cleared
  createEffect(() => {
    const item = selected();
    if (!item || !loaded()) {
      shell.setNoteState(null);
      return;
    }
    const status = kind() === "codex" ? versionStatus() : undefined;
    shell.setNoteState({
      title: noteTitle() || t().notes.untitled,
      version: status ? versionStatusLabel(status) : undefined,
      comparing: historyOpen() && compareLine().length > 0 ? compareLine().join(" · ") : undefined,
      map: mapShown(),
      examples: examplesShown() && item.template !== undefined,
      canCommit: canCommit(),
      canRevert: canRevert(),
      commit: () => {
        void commitVersion(item);
      },
      revert: () => {
        void revertEdit(item);
      },
      openSettings: () => openSettings(),
      openHistory: () => {
        void openHistory();
      },
    });
  });
  onCleanup(() => shell.setNoteState(null));

  /**
   * Esc peels one layer at a time. The tag input and the created-time field take theirs first
   * (they mark the key as handled), then the history. The last layer is the writing screen,
   * which gives way to the viewer. The settings tab stays: the panel was put there on
   * purpose, like the list.
   */
  const onEscape = (e: KeyboardEvent): void => {
    // A key pressed inside a corvu dialog (the sheet, a popover) is that dialog's
    const fromDialog = e.target instanceof Element && e.target.closest("[role='dialog']") !== null;
    if (fromDialog) {
      return;
    }
    if (peekFile()) {
      e.preventDefault();
      setPeekFile(null);
    } else if (historyOpen()) {
      e.preventDefault();
      closePanel();
    } else if (panelScreenShown()) {
      e.preventDefault();
      setPanelScreen(false);
    } else if (writing()) {
      e.preventDefault();
      stopWriting();
    }
  };

  /**
   * The keys that act on the open note. They are taken here because the target is "the one note
   * now selected": AppLayout's table holds only what means the same on every screen.
   *
   * The keys badged here are chosen not to collide with Milkdown (#211). Even so, the editor is
   * given precedence (`defaultPrevented`) so that when the editor takes more keys later, this
   * does not snatch keystrokes away in the middle of writing.
   *
   * Cmd-Up and Cmd-Down (to the start and end of the document) are the browser's default behavior,
   * and nobody calls preventDefault. Here they are told apart by whether the cursor is inside text.
   */
  onMount(() => {
    // The rows tried in order (lib/note-keys.ts)
    const keys = noteKeys({
      togglePanel,
      toggleMap,
      revertEdit,
      openDetails: () => openSettings(true),
      commitVersion,
      toggleHistory,
      isCodex: () => kind() === "codex",
    });
    const onKeyDown = (e: KeyboardEvent): void => {
      const item = selected();
      if (!item) {
        return;
      }
      // ProseMirror's base keymap takes Escape (selectParentNode) and marks it handled, so the
      // way out of the writing screen would never arrive. From inside the body it is ours,
      // unless an IME is converting: there Esc cancels the conversion
      const fromBody = e.target instanceof Element && e.target.closest(".ProseMirror") !== null;
      if (e.key === "Escape" && fromBody && !isImeComposing(e)) {
        onEscape(e);
        return;
      }
      if (e.defaultPrevented) {
        return;
      }
      if (e.target instanceof Element && e.target.closest(".palette-overlay, .search")) {
        return;
      }
      if (isWriteKey(e, writing())) {
        e.preventDefault();
        startWriting();
        return;
      }
      const typing = isTypingTarget(e.target);
      // The list grows upward from its foot (NoteList): ⌘↑ is the note drawn above, the older
      const step = matchesShortcut(e, "notePrev") ? 1 : -Number(matchesShortcut(e, "noteNext"));
      if (step !== 0) {
        if (typing) {
          return;
        }
        const next = stepNote(visibleItems(), item.id, step);
        if (next) {
          e.preventDefault();
          void switchTo(next);
        }
        return;
      }
      for (const key of keys) {
        if (matchesShortcut(e, key.shortcut) && (key.when?.() ?? true)) {
          e.preventDefault();
          void key.run(item);
          return;
        }
      }
      if (e.key === "Escape") {
        onEscape(e);
      }
    };
    globalThis.addEventListener("keydown", onKeyDown);
    onCleanup(() => globalThis.removeEventListener("keydown", onKeyDown));
  });

  /**
   * A phone's note is one level in from its list, so one level out (the round back button, the
   * stroke to the right) goes back there. The panel's sheet is a level further in and peels first.
   */
  const backToList = (): void => {
    if (panelScreenShown()) {
      setPanelScreen(false);
      return;
    }
    if (peekFile()) {
      setPeekFile(null);
      return;
    }
    // Writing is a level over reading: one back gives the page back to be read
    if (writing()) {
      stopWriting();
      return;
    }
    void session.settleEdit();
    setDetailOpen(false);
  };
  createEffect(() => {
    shell.setHeaderBack(detailOpen() && !twoPane() ? backToList : null);
  });
  onCleanup(() => shell.setHeaderBack(null));

  /**
   * What a stroke to the right slides on a phone (60, 61): the note, with its list showing
   * through under it, or the writing page with the same note to be read under it. Let go
   * short of a third and both spring back; nothing has moved.
   */
  createEffect(() => {
    if (twoPane() || !detailOpen()) {
      shell.setBackStage(null);
      return;
    }
    shell.setBackStage(() => {
      const page = detailPaneRef;
      if (!page || panelScreenShown() || peekFile()) {
        return null;
      }
      if (writing()) {
        setPeekReading(true);
        return {
          page,
          under: peekRef,
          done: (commit) => {
            setPeekReading(false);
            if (commit) {
              stopWriting();
            }
          },
        };
      }
      workspaceRef?.classList.add("workspace--peek");
      return {
        page,
        under: workspaceRef?.querySelector<HTMLElement>(".list-pane") ?? undefined,
        done: (commit) => {
          workspaceRef?.classList.remove("workspace--peek");
          if (commit) {
            backToList();
          }
        },
      };
    });
  });
  onCleanup(() => shell.setBackStage(null));

  /**
   * A wide window's note is a sheet lying over the list: pushed left it covers the list and
   * takes its room, pulled right it uncovers it. The grip on its edge and two fingers on a
   * trackpad both do it; the sheet slides from where it stood, so the step is seen.
   */
  const tuckList = (tucked: boolean): void => {
    const pane = detailPaneRef;
    const before = pane?.getBoundingClientRect().left ?? 0;
    shell.setListTucked(tucked);
    if (!pane) {
      return;
    }
    const after = pane.getBoundingClientRect().left;
    pane.classList.remove("palm-settling");
    pane.style.transform = `translateX(${before - after}px)`;
    // Reading the layout commits the starting place before the slide lets it go
    pane.getBoundingClientRect();
    pane.classList.add("palm-settling");
    pane.style.transform = "";
    setTimeout(() => pane.classList.remove("palm-settling"), 260);
  };

  // The levels a wide window's two-finger stroke steps through on this page: writing gives
  // way to reading first, then the list comes back or goes under the note (palm-gestures.ts)
  createEffect(() => {
    if (!twoPane() || !gripHostRef) {
      shell.setPageLevels(null);
      return;
    }
    shell.setPageLevels({
      out: () => {
        if (writing()) {
          return stopWriting;
        }
        return shell.listTucked() ? () => tuckList(false) : null;
      },
      cover: () => (shell.listTucked() ? null : () => tuckList(true)),
      beside: { tucked: shell.listTucked, tuck: tuckList, edge: gripHostRef },
    });
  });
  onCleanup(() => shell.setPageLevels(null));

  // The note the place pill's Note / Codex goes straight back to (93): the one last opened here
  createEffect(() => {
    const item = selected();
    if (item && (twoPane() || detailOpen())) {
      shell.setLastNote(kind(), item.filename);
    }
  });

  /** Up or Down in the list already moved the focus to `id`; the viewer follows it there. */
  const stepTo = (id: string): void => {
    openInViewer();
    void switchTo(id);
  };

  const createNote = async (): Promise<void> => {
    let path;
    try {
      path = await typedInvoke("create_draft", {
        body: "",
        tags: [],
        kind: kind(),
        client: await getDeviceSignals(),
      });
    } catch {
      shell.showToast(kind() === "codex" ? t().codex.createFailed : t().notes.createFailed);
      return;
    }
    await refetchNotes();
    shell.recordsChanged();
    // Open the note just created. Leaving the selection where it was would make whoever types a
    // title rewrite the title of the note they had open before
    const filename = path.split("/").at(-1);
    if (filename) {
      await switchTo(filename);
      startWriting();
    }
  };

  /**
   * Creates one note from a template and opens it to write.
   */
  const createFromTemplate = async (template: Template): Promise<void> => {
    shell.closePopovers();
    try {
      const created = await typedInvoke("create_from_template", {
        filename: template.filename,
        // Only the names of the weekdays follow the device's language. Only this side knows it
        locale: locale(),
        client: await getDeviceSignals(),
      });
      await refetchNotes();
      const filename = created.path.split("/").at(-1);
      if (filename) {
        await openFile(filename);
        startWriting();
      }
    } catch {
      shell.showToast(t().templates.createFailed);
    }
  };

  /**
   * Moves a Note into Codex's store. Neither the ID nor the body changes, only the surface.
   * There is no way back, so it is not an Undo; the held press takes that role (96).
   * The note it leaves gives its place to the next one (91): it stays on this list, so the
   * work carries on with the neighbour rather than an empty body. The Codex it became is the
   * one the place pill's Codex now goes straight to (93).
   */
  const promoteToCodex = async (item: NoteItem): Promise<void> => {
    shell.closePopovers();
    await session.settleWrites();
    const neighbor = neighborOf(visibleItems(), item.id);
    try {
      await typedInvoke("promote_note_to_codex", { filename: item.filename });
    } catch {
      // Nothing moved, so it stays on the note it was pressed on
      shell.showToast(t().codex.promoteFailed);
      return;
    }
    setPanelScreen(false);
    if (selected()?.id === item.id) {
      setSelectedId(neighbor);
    }
    shell.setLastNote("codex", item.filename);
    await refetchNotes();
    // Scrawl's origin chips are derived from the list too. The link survives the change of
    // surface, so make that side reread as well
    shell.refreshData();
    shell.showToast(t().codex.promoted);
  };

  /** A new note of either kind (65): this surface's here, the other's on its own surface. */
  const createKind = async (wanted: NoteKind): Promise<void> => {
    if (wanted === kind()) {
      await createNote();
      return;
    }
    try {
      const path = await typedInvoke("create_draft", {
        body: "",
        tags: [],
        kind: wanted,
        client: await getDeviceSignals(),
      });
      shell.recordsChanged();
      navigate(writeRoute(wanted, path.split("/").at(-1)));
    } catch {
      shell.showToast(wanted === "codex" ? t().codex.createFailed : t().notes.createFailed);
    }
  };

  // ---- delete + Undo (a tombstone for 5 s, the real delete after that) ----
  const remove = async (item: NoteItem): Promise<void> => {
    // Fold the edit before choosing the neighbor. Same reasoning as switchTo, but a delete does
    // not open the detail pane (on a narrow device the neighbor stays open), so it skips switchTo
    await session.settleEdit();
    // Decide the neighbor before hiding. selected falls back to the first for an id gone from the
    // list, so doing nothing would throw you to the top row on every delete. A neighbor keeps the
    // eye still. detailOpen is left alone: as before, a narrow device keeps the neighbor open
    const neighbor = neighborOf(visibleItems(), item.id);
    shell.closePopovers();
    batch(() => {
      setHidden((ids) => [...ids, item.id]);
      setSelectedId(neighbor);
    });

    const commit = setTimeout(() => {
      void (async () => {
        try {
          await typedInvoke("delete_note", { filename: item.filename });
        } catch {
          // Kept hidden, a note still on disk would read as deleted until the next start, so
          // its row comes back. The list is read again first: a Codex loses its body before its
          // versions, so the refusal can come with the file already gone. The selection stays
          // where the person has gone since
          await refetchNotes();
          setHidden((ids) => ids.filter((id) => id !== item.id));
          shell.showToast(t().notes.deleteFailed(item.title));
          return;
        }
        await refetchNotes();
        setHidden((ids) => ids.filter((id) => id !== item.id));
        // Scrawl's origin chips are derived from the note list. This refetch does not reach
        // another view if the person moves there during the Undo grace, so bump the version to
        // make that list reread too
        shell.refreshData();
      })();
    }, UNDO_MS);

    shell.showToast(t().notes.deleted, () => {
      clearTimeout(commit);
      batch(() => {
        setHidden((ids) => ids.filter((id) => id !== item.id));
        // An undo is the move back to "before the delete". Left on the neighbor, it would show a
        // different note even though it came back
        setSelectedId(item.id);
      });
    });
  };

  /**
   * How far the draft has moved since the newest version, for the commit to carry on itself
   * (92). Nothing before the first version: there is no "since" to measure from.
   */
  const commitDelta = (): string | undefined => {
    const status = versionStatus();
    return status && status.count > 0 && status.dirty
      ? t().codex.sizeDelta(status.bytes_delta)
      : undefined;
  };

  /**
   * The line at the top of a phone's sheet, the part still showing at its first stop: a
   * Codex's distance from its newest version, or, while a version is compared, what is
   * compared and the two ways out. The commit itself stands in the sheet's foot row, which
   * every stop shows (NotePanel's footActions).
   */
  function sheetSummary(item: () => NoteItem): JSX.Element {
    return (
      <Show when={kind() === "codex"}>
        <Show
          when={historyOpen() && selectedRow()}
          fallback={
            <div class="sheet-summary">
              <Show when={versionStatus()}>
                {(status) => <span class="sheet-summary-text">{versionStatusLabel(status())}</span>}
              </Show>
            </div>
          }
        >
          <div class="sheet-summary sheet-summary--compare">
            <span class="sheet-summary-text">
              <span class="compare-bar-title">
                {t().codex.comparing(selectedRow()?.number ?? 0)}
              </span>
              <span class="compare-bar-detail">
                {[compareDetail(), t().notes.readOnly].filter(Boolean).join(" · ")}
              </span>
            </span>
            <button
              type="button"
              class="detail-action-pill"
              disabled={selectedVersionId() === null}
              onClick={() => {
                const id = selectedVersionId();
                if (id !== null) {
                  void restoreVersion(item(), id);
                }
              }}
            >
              <Icon name="arrow-counter-clockwise" size={13} />
              {t().codex.restoreShort}
            </button>
            <button
              type="button"
              class="icon-button"
              aria-label={t().codex.close}
              onClick={closePanel}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </Show>
      </Show>
    );
  }

  /** The panel's tags. The meta line only shows them. */
  const tagEditor = (item: () => NoteItem, screen: boolean): JSX.Element => (
    <TagEditor
      tags={item().tags}
      own={currentMeta()?.tags}
      known={usedTags() ?? []}
      editing={tagEditing()}
      onEditingChange={setTagEditing}
      onChange={(tags) => {
        void saveMeta(item(), { tags });
      }}
      onRemoved={(tag, at) => {
        const { filename } = item();
        shell.showToast(t().meta.tagRemoved(tag), () => {
          void restoreTag(filename, tag, at);
        });
      }}
      screen={screen}
    />
  );

  /** One panel, two presentations: the 320px slot at the right edge, or the phone's screen. */
  const notePanel = (item: () => NoteItem, screen: boolean): JSX.Element => (
    <NotePanel
      kind={kind()}
      screen={screen}
      title={noteTitle()}
      open={screen || panelOpen()}
      tab={panelTab()}
      historyCount={versionRows().length}
      onTab={selectTab}
      mapOpen={mapOpen()}
      // While folded the table is empty, so judge by the template it came from
      hasExamples={item().template !== undefined}
      examplesShown={examplesShown()}
      onToggleMap={() => {
        void toggleMap(item());
      }}
      onToggleExamples={() => setExamplesShown(!examplesShown())}
      detailsOpen={detailsOpen()}
      onToggleDetails={() => setDetailsOpen((open) => !open)}
      meta={currentMeta()}
      metaError={metaFailed()}
      onEditTime={(value) => {
        const meta = currentMeta();
        const time = meta ? resolveEditedTime(meta.time, value) : undefined;
        if (time !== undefined && time !== meta?.time) {
          void saveMeta(item(), { time });
        }
      }}
      tags={() => tagEditor(item, screen)}
      canRevert={canRevert()}
      revertHint={revertHint()}
      onRevert={() => {
        void revertEdit(item());
      }}
      onPromote={() => {
        void promoteToCodex(item());
      }}
      commitDelta={commitDelta()}
      paper={shell.paper()}
      onTogglePaper={() => shell.setPaper(!shell.paper())}
      summary={screen ? sheetSummary(item) : undefined}
      onCommit={() => {
        void commitVersion(item());
      }}
      onDelete={() => {
        // The panel screen belongs to the note being deleted. Left up, it would describe the
        // neighbour that takes its place without anyone having opened it
        setPanelScreen(false);
        void remove(item());
      }}
      history={
        <HistoryPanel
          screen={screen}
          rows={versionRows()}
          summary={cadence()}
          dirty={versionStatus()?.dirty ?? false}
          bytesDelta={versionStatus()?.bytes_delta ?? 0}
          selectedId={selectedVersionId()}
          freshId={freshVersionId()}
          onSelect={(id) => {
            batch(() => {
              setSelectedVersionId(id);
              // On a phone the body is where a version is compared: the sheet sinks to its
              // first stop, which then reads as the compare line (29)
              if (screen) {
                setSheetPoint(SHEET_LITTLE);
              }
            });
          }}
          onRestore={(id) => {
            void restoreVersion(item(), id);
          }}
          onCommit={() => {
            void commitVersion(item());
          }}
        />
      }
    />
  );

  /** The sheet's name: the note's own panel, "this Note" or "this Codex". */
  const sheetLabel = (): string => (kind() === "codex" ? t().codex.panel : t().notes.panel);

  // A sheet opening starts half way: the history and the body it compares both stay in sight
  createEffect(
    on(panelScreenShown, (shown) => {
      if (shown) {
        setSheetPoint(SHEET_HALF);
      }
    }),
  );

  return (
    <div
      class="workspace"
      classList={{
        "workspace--detail": detailOpen(),
        "workspace--tucked": twoPane() && shell.listTucked(),
      }}
      ref={workspaceRef}
    >
      <NoteList
        kind={kind()}
        groups={groups()}
        items={visibleItems()}
        selectedId={selected()?.id}
        templates={templates() ?? []}
        today={today}
        onSelect={select}
        onStep={stepTo}
        onCreate={() => {
          void createNote();
        }}
        onCreateKind={(wanted) => {
          void createKind(wanted);
        }}
        onWriteRow={(row) => {
          select(row);
          setSearchParams({ edit: "1" }, { replace: true });
        }}
        onPromoteRow={(row) => {
          void promoteToCodex(row);
        }}
        onDeleteRow={(row) => {
          void remove(row);
        }}
        onAppendRow={(row) => {
          void appendTo(row);
        }}
        pageTargetAt={(x, y) => (twoPane() ? pageTargetAt(x, y) : null)}
        onCreateFromTemplate={(template) => {
          void createFromTemplate(template);
        }}
        onManageTemplates={() => navigate(ROUTES.TEMPLATES)}
      />

      {/* The page to be read, under the one being written while a finger slides it away (61) */}
      <Show when={peekReading() && selected()}>
        <div class="detail-peek" ref={peekRef} aria-hidden="true">
          <h1 class="note-title-view">{noteTitle() || t().notes.untitled}</h1>
          <MarkdownPreview source={noteBody()} noteTitles={noteTitles()} glyphs={glyphs()} />
        </div>
      </Show>

      <div
        class="detail-pane"
        ref={detailPaneRef}
        classList={{
          // While the history is open the map is not drawn. Keeping only the width would narrow it
          // by a map that has no title row, so it would stop lining up with the body column
          "detail-pane--map": mapShown(),
          // Docked, the panel takes its 320px from the body; floating, it lies over it
          // A linked note lifted on a wide window lies in the panel's place, over the panel if it
          // is open: the body yields the room either way, so the card covers none of the text
          "detail-pane--panel":
            selected() !== undefined &&
            twoPane() &&
            (shell.notePanelPinned() || peekFile() !== null),
        }}
      >
        {/* The note sheet's grip stands on its left edge: AppLayout puts the one grip, the
            list's, in here (`beside`). A host of its own, since the pane's own children are
            redrawn whole when the note changes */}
        <div class="sheet-grip-host" ref={gripHostRef} />
        <Show when={selected()} fallback={<div class="detail-empty">{t().notes.noSelection}</div>}>
          {(item) => {
            /** The title, the meta line and the state row: one block drawn in one of two places. */
            const head = (): JSX.Element => (
              <div class="detail-head">
                {/* The title is the H1 at the top of the body itself. What is typed here is
                    written back into the body as a `# heading` (`note-title.ts`), so the editor
                    and the preview do not hold the title line. The viewer reads it as a heading */}
                <Show when={writing()}>
                  <div class="detail-title-row">
                    <input
                      type="text"
                      class="note-title-input"
                      placeholder={t().notes.titlePlaceholder}
                      aria-label={t().notes.titlePlaceholder}
                      value={noteTitle()}
                      // It does not move until the body arrives (the previous note's title is up)
                      readOnly={!loaded()}
                      onInput={(e) => editTitle(e.currentTarget.value)}
                      onChange={() => {
                        void commitTitle();
                      }}
                      onKeyDown={(e) => {
                        // The Enter that ends IME conversion is the IME's (#102)
                        if (e.key === "Enter" && !isImeComposing(e)) {
                          e.preventDefault();
                          focusBody();
                        }
                      }}
                    />
                  </div>
                </Show>

                {/* Created time and tags, in the viewer only. The filename is the ID that sync
                    and widgets point at, not something to show a person */}
                <Show when={!writing()}>
                  <h1 class="note-title-view">{noteTitle() || t().notes.untitled}</h1>
                  <div class="detail-meta-line">
                    {metaLine(item(), bodyTags())}
                    {/* A Codex always shows how far it has moved from the newest version */}
                    <Show when={kind() === "codex" && versionStatus()}>
                      {(status) => (
                        <span
                          class="detail-version-status"
                          classList={{ "detail-version-status--moved": status().dirty }}
                        >
                          {versionStatusLabel(status())}
                        </span>
                      )}
                    </Show>
                  </div>
                </Show>

                <NoteStatusRow
                  saveStatus={saveStatus()}
                  savedAt={savedAt()}
                  mapShown={mapShown()}
                  examplesShown={examplesShown() && item().template !== undefined}
                  canCommit={canCommit()}
                  canRevert={canRevert()}
                  onOpenSettings={() => openSettings()}
                  onCommit={() => {
                    void commitVersion(item());
                  }}
                  onRevert={() => {
                    void revertEdit(item());
                  }}
                />
              </div>
            );
            return (
              <>
                {/* The body stays under the phone's sheet as it does beside the wide window's
                  panel: the sheet rises over it and stops part way (29) */}
                {/* Title, record and actions in one group. They sit on the same level as the body,
                  so what you want to know about a note is not searched for somewhere far away */}
                <NoteStrip
                  kind={kind()}
                  writing={writing()}
                  mapOpen={mapOpen()}
                  historyOpen={historyOpen()}
                  slim={shell.slim()}
                  onToggleMap={() => {
                    void toggleMap(item());
                  }}
                  onWrite={startWriting}
                  onDone={stopWriting}
                  onTogglePanel={togglePanel}
                  onPaper={() => shell.setPaper(!shell.paper())}
                />

                {/* A phone reading a note scrolls the head away with the body (4): the large
                    title opens the page and then gives the screen to the text. Writing, or on a
                    wide window, it stands over the body */}
                <Show when={!headInBody()}>{head()}</Show>
                <div class="detail-panes" classList={{ "detail-panes--map": mapShown() }}>
                  {/* For biome-ignore/eslint: what is caught here is only a note link with no
                    href. Writing actions are taken by the editor itself */}
                  <div
                    class="detail-body"
                    data-view={historyOpen() ? "history" : noteView()}
                    ref={detailBodyRef}
                    role="presentation"
                    onClick={onBodyClick}
                    // A tap is about to want the editor: start fetching its chunk on the press,
                    // so the caret lands while the tap still counts as the user's (the phone's
                    // keyboard opens only for a focus close to a gesture)
                    onPointerDown={() => {
                      if (!writing()) {
                        void import("../components/MilkdownEditor");
                      }
                    }}
                  >
                    <Show when={headInBody()}>{head()}</Show>
                    {/* While the history is open the body turns read-only and the difference from
                      the chosen version becomes gutter marks. The editor is folded away:
                      left open below, the restored body and the old document would both exist */}
                    <Show when={historyOpen()}>
                      <MarkdownPreview
                        source={marked()?.source ?? noteBody()}
                        marks={marked()?.marks ?? []}
                        noteTitles={noteTitles()}
                        glyphs={glyphs()}
                        exportStem={item().filename.replace(/\.md$/u, "")}
                        onError={(message) => shell.showToast(message)}
                      />
                    </Show>
                    <Show when={!historyOpen()}>
                      <Show
                        when={writing()}
                        fallback={
                          <>
                            <MarkdownPreview
                              source={noteBody()}
                              noteTitles={noteTitles()}
                              glyphs={glyphs()}
                              exportStem={item().filename.replace(/\.md$/u, "")}
                              onError={(message) => shell.showToast(message)}
                            />
                            <Backlinks hits={backlinks() ?? []} onOpen={openBacklink} />
                          </>
                        }
                      >
                        {/* The editor holds its own document as the truth, so it is rebuilt when
                        the body is replaced. Inserting destroys the cursor and the IME.
                        It is not stood up until the body arrives: characters typed into an
                        editor stood up with the previous note's body go to the next note */}
                        <Show when={bodyVisible() && loaded() && bodyEpoch()} keyed>
                          <MilkdownEditor
                            placeholder={t().notes.bodyPlaceholder}
                            noteLinks={linkTargets}
                            glyphs={glyphs}
                            examples={examples}
                            defaultValue={noteBody()}
                            onChange={(markdown) => {
                              if (!loaded()) {
                                return;
                              }
                              // A dropped line nothing has been typed on is not an edit yet
                              // (7): the body and its save wait for the first word
                              const settled = settleOpenedLine(
                                openedLine,
                                selected()?.id,
                                markdown,
                              );
                              openedLine = settled.line;
                              if (settled.skip) {
                                return;
                              }
                              session.ensure();
                              setNoteBody(markdown);
                              session.schedule();
                            }}
                            onEditorReady={setMarkdownEditor}
                          />
                        </Show>
                      </Show>
                    </Show>
                  </div>

                  {/* The map does not replace the body; it is laid beside it. Below 1100px there
                    is no width to lay it out, so only there it swaps with the body (in CSS) */}
                  {/* When the body was replaced whole (`bodyEpoch`), redraw without waiting.
                    Made to wait, the previous note's diagram stays for a beat */}
                  <Show when={mapShown() && bodyEpoch()} keyed>
                    <NoteMap source={fullBody} />
                  </Show>
                </div>

                {/* Compare mode on a phone with the sheet put away: the line that says so and
                  leads back (the sheet's first stop says the same while it is up) */}
                <Show when={compareBarOpen()}>
                  <div class="compare-bar">
                    <span class="compare-bar-text">
                      <span class="compare-bar-title">
                        {selectedRow() ? t().codex.comparing(selectedRow()?.number ?? 0) : ""}
                      </span>
                      <span class="compare-bar-detail">
                        {[compareDetail(), t().notes.readOnly].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <button
                      type="button"
                      class="button-secondary"
                      onClick={() => setPanelScreen(true)}
                    >
                      {t().codex.history}
                    </button>
                    <button
                      type="button"
                      class="icon-button compare-bar-close"
                      aria-label={t().codex.close}
                      onClick={closePanel}
                    >
                      <Icon name="x" size={16} />
                    </button>
                  </div>
                </Show>

                {/* The phone's reading hand (63): the note's sheet and the pencil, low on the
                  right opposite the place pill. Reading down, the sheet's button steps away and
                  the pencil stays */}
                <Show
                  when={
                    !twoPane() &&
                    detailOpen() &&
                    !writing() &&
                    !panelScreenShown() &&
                    !compareBarOpen()
                  }
                >
                  <div class="palm-actions" classList={{ "palm-actions--slim": shell.slim() }}>
                    <button
                      type="button"
                      class="palm-action-more"
                      title={sheetLabel()}
                      aria-label={sheetLabel()}
                      onClick={() => togglePanel()}
                    >
                      <Icon name="dots-three" size={20} />
                    </button>
                    <button
                      type="button"
                      class="compose-fab ring-trigger"
                      title={`${t().viewer.write} · ${t().reach.dragPencil}`}
                      aria-label={t().viewer.write}
                      data-no-gesture
                      {...pencil.handlers}
                      onClick={() => {
                        if (pencil.shouldClick()) {
                          startWriting();
                        }
                      }}
                    >
                      <Icon name="pencil" size={22} />
                    </button>
                  </div>
                  {pencil.view()}
                </Show>

                {/* A phone's panel is a sheet from the foot that stops a little, half way or all
                  the way up (29). Non-modal: the note above it is still read and scrolled */}
                <Show when={!twoPane()}>
                  <Drawer
                    open={panelScreenShown()}
                    onOpenChange={(open) => {
                      if (!open) {
                        closePanel();
                      }
                    }}
                    snapPoints={SHEET_POINTS}
                    defaultSnapPoint={SHEET_HALF}
                    activeSnapPoint={sheetPoint()}
                    onActiveSnapPointChange={setSheetPoint}
                    modal={false}
                    trapFocus={false}
                    preventScroll={false}
                    closeOnOutsidePointer={false}
                    noOutsidePointerEvents={false}
                    restoreFocus={false}
                  >
                    <Drawer.Content
                      class="note-sheet"
                      aria-label={sheetLabel()}
                      style={{ "--sheet-stop": sheetStopHeight(sheetPoint()) }}
                    >
                      <div class="note-sheet-grip" title={t().palm.grip} aria-hidden="true" />
                      {notePanel(item, true)}
                    </Drawer.Content>
                  </Drawer>
                </Show>

                {/* A linked note lifted over this one (88): read it, open it for real, or let it
                  drop back */}
                <Show when={peekFile()} keyed>
                  {(file) => (
                    <LinkPeek
                      filename={file}
                      title={allItems().find((note) => note.filename === file)?.title}
                      sheet={!twoPane()}
                      noteTitles={noteTitles()}
                      onOpen={() => {
                        setPeekFile(null);
                        void openFile(file);
                      }}
                      onClose={() => setPeekFile(null)}
                    />
                  )}
                </Show>

                {/* In a wide window, 320px at the right edge. It exists even when folded, so
                  opening and closing read as a 220ms slide */}
                <Show when={twoPane()}>{notePanel(item, false)}</Show>
              </>
            );
          }}
        </Show>
      </div>

      {/* The writing bar: over the keyboard on a touch device, at the foot of the page where a
          pointer is. It is lazy, so drawing it unconditionally would load the whole editor just
          from looking at the list. It is drawn only once the editor is up */}
      <Show when={markdownEditor()}>
        {(editor) => (
          <MarkdownToolbar
            editor={editor()}
            onDone={stopWriting}
            mount={matchMedia("(hover: hover)").matches ? detailPaneRef : undefined}
          />
        )}
      </Show>
    </div>
  );
}
