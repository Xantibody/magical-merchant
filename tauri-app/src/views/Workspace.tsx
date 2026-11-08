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
import HistoryPanel from "../components/HistoryPanel";
import Icon from "../components/Icon";
import KindDot from "../components/KindDot";
import MarkdownPreview from "../components/MarkdownPreview";
import NotePanel from "../components/NotePanel";
import type { NotePanelTab } from "../components/NotePanel";
import Popover from "../components/Popover";
import PromoteDialog from "../components/PromoteDialog";
import TagEditor from "../components/TagEditor";
import TemplatePicker from "../components/TemplatePicker";
import { isStaleSave, typedInvoke } from "../lib/commands";
import { resolveEditedTime } from "../lib/note-meta";
import { countTagLists, parseTags } from "../lib/tags";
import { refusedForGood } from "../lib/save-refusal";
import { createNoteBuffer } from "../lib/note-buffer";
import { createNoteSelection } from "../lib/note-selection";
import { createNoteSession } from "../lib/note-session";
import type { SaveStatus } from "../lib/note-session";
import { getDeviceSignals } from "../lib/client-context";
import { createDebouncedAccessor } from "../lib/debounce";
import { diffLineCounts, markedBody } from "../lib/diff-marks";
import { glyphs } from "../lib/glyphs";
import { examplesShown, extractExamples, setExamplesShown } from "../lib/template-examples";
import { useShell } from "../lib/shell";
import {
  groupNotes,
  itemTitle,
  neighborOf,
  noteCreatedLabel,
  noteRowStamp,
  stepNote,
  toNoteItems,
} from "../lib/items";
import type { ItemGroup, NoteItem } from "../lib/items";
import { readNoteContent, viewToFrontmatter } from "../lib/note-view";
import type { NoteView } from "../lib/note-view";
import { splitTitle } from "../lib/note-title";
import { formatClock, formatMonthDay } from "../lib/day-labels";
import { locale, t } from "../lib/i18n";
import { isImeComposing } from "../lib/ime";
import { createLongPress } from "../lib/long-press";
import { isTypingTarget, matchesShortcut, shortcutLabel } from "../lib/shortcuts";
import { daysSince, spanSince, withDeltas } from "../lib/versions";
import type { VersionRow } from "../lib/versions";
import { readBackup, writeBackup } from "../lib/edit-backup";
import type { NoteLinkTarget } from "../lib/note-link-plugin";
import type { NoteKind, NoteMeta, SearchHit, Template, VersionStatus } from "../lib/commands";
import { noteRoute } from "../lib/note-route";
import { MODE_LABELS, ROUTES } from "../lib/routes";
import "../styles/workspace.css";

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
/** How long a just-committed version pops (`mm-pop`). Past that the row goes back to normal. */
const POP_MS = 350;
/** The empty table a note with no examples passes. Recreating it redraws the plugin every time. */
const NO_EXAMPLES: ReadonlyMap<string, string[]> = new Map();
/** The keys that move to the neighboring row in the list, and their direction. */
const LIST_STEP_KEYS: Readonly<Record<string, 1 | -1>> = { ArrowUp: -1, ArrowDown: 1 };

async function loadNotes(): Promise<NoteItem[]> {
  return toNoteItems(await typedInvoke("list_notes"));
}

function EmptyNotes(props: { kind: NoteKind }): JSX.Element {
  const words = (): { empty: string; emptyHint: string } =>
    props.kind === "codex" ? t().codex : t().notes;
  return (
    <div class="notes-empty">
      <Icon name={props.kind === "codex" ? "book" : "note-pencil"} size={24} />
      <p class="notes-empty-title">{words().empty}</p>
      <p class="notes-empty-body">{words().emptyHint}</p>
    </div>
  );
}

/**
 * The folded-corner page at the right end of a list row, left of the date. The version count sits
 * inside. The frame's color says "no versions / has versions / the draft has moved on". No words
 * are added: the row stays one line.
 */
function PageMark(props: { count: number; dirty: boolean }): JSX.Element {
  const state = (): "none" | "clean" | "dirty" => {
    if (props.count === 0) {
      return "none";
    }
    return props.dirty ? "dirty" : "clean";
  };
  return (
    <span
      class="page-mark"
      data-state={state()}
      title={t().codex.pageMark(props.count, props.dirty)}
      aria-hidden="true"
    >
      <span class="page-mark-face" />
      <Show when={props.count > 0}>
        <span class="page-mark-fold" />
        <span class="page-mark-count">{props.count}</span>
      </Show>
    </span>
  );
}

/** The meta line's "+312 B from version 4". If unmoved, "version 4"; if none, "no versions". */
function versionStatusLabel(status: VersionStatus): string {
  if (status.count === 0) {
    return t().codex.noVersions;
  }
  return status.dirty
    ? t().codex.deltaFromLatest(status.count, status.bytes_delta)
    : t().codex.versionN(status.count);
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
  /**
   * Whether the history is open, that is compare mode. Codex only. The body turns read-only and
   * the difference from the chosen version becomes gutter marks; the body never disappears.
   * In a wide window it is also which tab the right panel shows: the history tab is open
   * exactly while this is on, so the two cannot disagree.
   */
  const [historyOpen, setHistoryOpen] = createSignal(false);
  /** The version chosen in the history. The newest one the moment it opens. */
  const [selectedVersionId, setSelectedVersionId] = createSignal<string | null>(null);
  /**
   * Whether the panel screen is up on a phone. There is no width to lay it alongside, so it is
   * one surface that swaps with the body. Pressing a version returns to the body in compare
   * mode, with the compare bar attached below.
   */
  const [panelScreen, setPanelScreen] = createSignal(false);
  /** Whether the panel's details (created, updated, surroundings) are unfolded. */
  const [detailsOpen, setDetailsOpen] = createSignal(false);
  /** Whether the "Make a Codex" confirmation is up. */
  const [confirmOpen, setConfirmOpen] = createSignal(false);
  /** Whether the tags on the meta line (or the phone's panel) are being edited. */
  const [tagEditing, setTagEditing] = createSignal(false);
  /** The version just committed. Only that row in the history pops as it enters. */
  const [freshVersionId, setFreshVersionId] = createSignal<string | null>(null);
  /** What a touch device's toolbar acts on. undefined while no note is open. */
  const [markdownEditor, setMarkdownEditor] = createSignal<Editor | undefined>();

  const [notes, { refetch: refetchNotes }] = createResource(loadNotes);
  // It does not open until "new" is pressed, but starting the read at that moment draws an empty
  // menu once. There are only a few of them, so fetching them with the list costs nothing visible
  const [templates, { refetch: refetchTemplates }] = createResource(() =>
    typedInvoke("list_templates"),
  );

  let detailBodyRef: HTMLDivElement | undefined;
  let listScrollRef: HTMLDivElement | undefined;
  /** The "+ new" button. It opened the template sheet, so a press on it does not count as outside */
  let newNoteButton: HTMLButtonElement | undefined;
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

  /** Whether the panel screen is up on a phone. It swaps with the body. */
  const panelScreenShown = (): boolean => panelScreen() && !twoPane();

  /** Whether the right panel is on screen in a wide window. */
  const panelOpen = (): boolean => twoPane() && shell.notePanelPinned();

  /** Which tab the panel shows. The history tab is compare mode itself. */
  const panelTab = (): NotePanelTab => (historyOpen() ? "history" : "note");

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
   * The tags written in the body as `#tag`. The meta line tells them from the frontmatter's
   * by an outline alone: they are edited where they are written, not in the panel.
   */
  const bodyTags = createMemo<ReadonlySet<string>>(() => new Set(parseTags(fullBody())));

  /**
   * The table that resolves `[[ID]]` to a title. The preview looks it up every time it draws.
   * It is not narrowed by surface: a note moved from Note to Codex is still pointed at by the same
   * ID, and opening it sends you to the other surface.
   */
  const noteTitles = createMemo<ReadonlyMap<string, string>>(
    () => new Map(allItems().map((item) => [item.filename.replace(/\.md$/u, ""), item.title])),
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

  /**
   * The frontmatter as written. The list carries tags already merged with the body's `#tag`s,
   * so what can be edited (the frontmatter's own tags, the created time) is read only while the
   * panel that edits it is open. It is read again each time, so another device's edit is not
   * written back over.
   */
  const [noteMeta, { refetch: refetchMeta, mutate: mutateMeta }] = createResource(
    () => (panelScreenShown() || panelOpen() ? selected()?.filename : undefined),
    async (filename) => ({ filename, meta: await typedInvoke("read_note_meta", { filename }) }),
  );
  /**
   * The frontmatter of the note on screen, never the previous one's. The resource keeps its
   * last value while the next note's is on the way, and tags edited against it would carry
   * one note's tags into another.
   */
  const currentMeta = (): NoteMeta | undefined => {
    if (noteMeta.error) {
      return undefined;
    }
    const read = noteMeta();
    return read && read.filename === selected()?.filename ? read.meta : undefined;
  };

  /**
   * Tags used anywhere, most used first: the suggestions under the tag input. Counted from the
   * same records Browse reads, and only once the tags are pressed.
   */
  const [usedTags] = createResource(
    () => tagEditing() || undefined,
    async () => {
      try {
        const hits = await typedInvoke("browse_all");
        return countTagLists(hits.map((hit) => hit.tags));
      } catch {
        // Without suggestions a tag can still be typed in full
        return [];
      }
    },
  );

  /**
   * Rewrites the frontmatter's tags or created time. The value on screen moves first, so a
   * second tag added before the first write lands is added to the list that has the first.
   */
  const saveMeta = async (
    item: NoteItem,
    change: { time?: string; tags?: string[] },
  ): Promise<void> => {
    const meta = currentMeta();
    if (!meta) {
      return;
    }
    const next = { ...meta, ...change };
    mutateMeta({ filename: item.filename, meta: next });
    try {
      await typedInvoke("update_note_meta", {
        filename: item.filename,
        time: next.time,
        tags: next.tags,
      });
    } catch {
      shell.showToast(t().meta.saveFailed);
      void refetchMeta();
      return;
    }
    // The created time moves the row between date groups, and the tags show on the meta line
    await refetchNotes();
  };

  /**
   * Puts a removed tag back where it stood. The note is read afresh rather than through
   * `saveMeta`: the toast outlives the selection, and `currentMeta` may be another note's by now.
   */
  const restoreTag = async (filename: string, tag: string, at: number): Promise<void> => {
    try {
      const read = await typedInvoke("read_note_meta", { filename });
      const tags = [...read.tags.slice(0, at), tag, ...read.tags.slice(at)];
      await typedInvoke("update_note_meta", { filename, time: read.time, tags });
      if (selected()?.filename === filename) {
        mutateMeta({ filename, meta: { ...read, tags } });
      }
    } catch {
      shell.showToast(t().meta.saveFailed);
      return;
    }
    await refetchNotes();
  };

  // The version count and "how far it has moved from the newest version". It compares the body
  // against a version, so it reads only the one note that is open (the mark on a list row comes
  // from core using the name fingerprint alone)
  const [versionStatus, { refetch: refetchVersionStatus }] = createResource(
    () => (kind() === "codex" ? selected()?.filename : undefined),
    (filename) => typedInvoke("note_version_status", { filename }),
  );
  // The versions themselves. Even folded, the spine dots once per version, so a Codex reads them
  const [versions, { refetch: refetchVersions }] = createResource(
    () => (kind() === "codex" ? selected()?.filename : undefined),
    (filename) => typedInvoke("list_note_versions", { filename }),
  );
  const versionRows = createMemo<VersionRow[]>(() => withDeltas(versions() ?? []));

  /** When versions are added or removed, reread the count, the spine and the list mark together. */
  const refreshVersions = (): void => {
    void refetchVersionStatus();
    void refetchVersions();
  };

  // The diff from the chosen version to the draft. Only while the history is open
  const [diff] = createResource(
    () => {
      const id = selectedVersionId();
      const filename = selected()?.filename;
      return historyOpen() && id !== null && filename ? { filename, from: id } : undefined;
    },
    (args) => typedInvoke("diff_note_versions", args),
  );

  /**
   * The body with the gutter marks applied. An empty diff (same content) means no marks and the
   * body as it is. Saves are flushed when the history opens, so the body on screen equals disk.
   */
  const marked = createMemo(() => {
    const text = diff();
    return text ? markedBody(fullBody(), text) : undefined;
  });
  /**
   * "committed 4 times in 9 months", the line at the top of the history tab. The span since the
   * first version comes from the list.
   */
  const cadence = (): string | undefined => {
    const rows = versionRows();
    const oldest = rows.at(-1);
    return oldest
      ? t().codex.cadence(rows.length, spanSince(oldest.version.time, new Date()))
      : undefined;
  };

  /** The row chosen in the history. It gives the number and decides what to restore to. */
  const selectedRow = createMemo<VersionRow | undefined>(() =>
    versionRows().find((row) => row.version.id === selectedVersionId()),
  );

  /**
   * "3 lines added, 1 line removed". It counts from the diff compare mode has already read, so
   * showing it adds not one IPC call. Identical content reads as "same content".
   */
  const compareDetail = (): string => {
    const text = diff();
    if (text === undefined) {
      return "";
    }
    const { added, removed } = diffLineCounts(text);
    return added + removed === 0 ? t().codex.sameShort : t().codex.lineDelta(added, removed);
  };

  /**
   * Whether to show the compare bar. While compare mode is on, on a phone. It shows even when the
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
      // The history, the half-typed tag and the confirmation belong to the note that was open.
      // Whether the panel is docked does not: that is the app's, like the list's pin
      setHistoryOpen(false);
      setSelectedVersionId(null);
      setTagEditing(false);
      setConfirmOpen(false);
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
   * A note link is resolved inside this app. It is an `a` with no href, so a press is caught here
   * and opened, on a read-only note and on the map alike.
   */
  const onBodyClick = (e: MouseEvent): void => {
    const target = e.target instanceof Element ? e.target : null;
    const noteLink = target?.closest("a.note-link");
    if (noteLink instanceof HTMLElement && noteLink.dataset.file) {
      void openFile(noteLink.dataset.file);
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
    // Drop the pending save. The body now on screen is about to become the backup, so there is no
    // point going to disk to write the same thing again
    session.cancelPending();
    let written = true;
    try {
      const revision = await typedInvoke("update_draft", {
        filename: item.filename,
        body: backup,
        client: await getDeviceSignals(),
        revision: session.revisionOf(item.filename) ?? null,
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

  /**
   * Commits the current draft as a version. This is the only entry, and nothing commits
   * automatically. It hangs on neither save, leave nor promotion: a version is the mark a person
   * puts at "this far".
   *
   * It commits the moment it is pressed. No message is asked for: "version N, date" is enough for
   * a version's name, and asking makes committing itself feel like a chore. Instead a toast says
   * the summary, and during the grace period it can be undone (which only deletes the version's
   * file).
   */
  const commitVersion = async (item: NoteItem): Promise<void> => {
    if (kind() !== "codex" || !loaded()) {
      return;
    }
    shell.closePopovers();
    // The body on disk is committed. Unless the in-flight save lands, the last typing misses it
    await session.settleWrites();
    const before = versions() ?? [];
    let version;
    try {
      version = await typedInvoke("commit_note_version", {
        filename: item.filename,
        message: null,
      });
    } catch {
      shell.showToast(t().codex.commitFailed);
      return;
    }
    // Committing the same body in the same second makes core return the previous version as it is.
    // What did not grow cannot be undone: deleting it would delete a version that already existed
    const existed = before.some((v) => v.id === version.id);
    const [latest] = before;
    const count = existed ? before.length : before.length + 1;
    const summary = [
      latest
        ? t().codex.deltaFromLatest(before.length, version.bytes - latest.bytes)
        : t().codex.sizeOf(version.bytes),
      latest && daysSince(latest.time, new Date()) > 0
        ? t().codex.sinceDays(daysSince(latest.time, new Date()))
        : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    // If the history is open, only the one added row pops in. When it merely pointed again at a
    // version that already existed, nothing moves
    if (!existed) {
      setFreshVersionId(version.id);
      setTimeout(() => setFreshVersionId(null), POP_MS);
    }
    refreshVersions();
    // The folded-corner page in the list changes its count and frame too
    void refetchNotes();
    const undo = existed
      ? undefined
      : (): void => {
          void (async () => {
            try {
              await typedInvoke("delete_note_version", {
                filename: item.filename,
                id: version.id,
              });
            } catch {
              return;
            }
            refreshVersions();
            void refetchNotes();
          })();
        };
    shell.showToast(t().codex.committed(count), undo, summary);
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
    if (twoPane()) {
      shell.setNotePanelPinned(true);
    } else {
      setPanelScreen(true);
    }
    if (historyOpen()) {
      return;
    }
    await session.settleWrites();
    // Versions are committed on other devices too. Opening the compare screen is a cheap moment to
    // reread. The newest version is chosen from the reread list: from the local list, an older one
    // would keep opening as long as it is still in the arriving list, even when a newer one exists
    void refetchVersionStatus();
    const rows = (await refetchVersions()) ?? versions();
    batch(() => {
      setSelectedVersionId(rows?.[0]?.id ?? null);
      setHistoryOpen(true);
    });
  };

  /** Leaves compare mode. The panel stays where it is, on its settings tab. */
  const leaveHistory = (): void => {
    batch(() => {
      setHistoryOpen(false);
      setSelectedVersionId(null);
    });
  };

  /**
   * Folds the panel entirely, compare mode included. Opening it again always starts on the
   * settings tab, so a panel that appears never starts by comparing.
   */
  const closePanel = (): void => {
    batch(() => {
      leaveHistory();
      shell.setNotePanelPinned(false);
      setPanelScreen(false);
    });
  };

  /** ⌘. and the strip's …. Opens the panel, or folds it. On a phone, the panel screen. */
  const togglePanel = (): void => {
    if (writing()) {
      return;
    }
    if (!twoPane()) {
      setPanelScreen((open) => !open);
      return;
    }
    if (shell.notePanelPinned()) {
      closePanel();
      return;
    }
    shell.setNotePanelPinned(true);
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
      if (twoPane()) {
        shell.setNotePanelPinned(true);
      } else {
        setPanelScreen(true);
      }
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

  // If the versions have not arrived when it opens, choose the newest one that arrives. It also
  // moves to the newest when an undo removed the version that was chosen
  createEffect(() => {
    if (!historyOpen()) {
      return;
    }
    const rows = versions();
    if (!rows) {
      return;
    }
    const chosen = selectedVersionId();
    if (chosen === null || !rows.some((v) => v.id === chosen)) {
      setSelectedVersionId(rows[0]?.id ?? null);
    }
  });

  /**
   * Makes a version's body the draft. core commits "before the restore" first, so the restore
   * itself can be undone from the history too. The write goes through the same check as
   * `update_draft`, so if it was rewritten outside after the read, it gives way by the same path.
   */
  const restoreVersion = async (item: NoteItem, id: string): Promise<void> => {
    if (!loaded()) {
      return;
    }
    // Drop the pending save. What is restored is the body on disk; keystrokes on screen do not go
    // into the "before the restore" version, but settleEdit already ran when the history opened
    session.cancelPending();
    // The revision from when the body on screen was read. Where to fall back if the reread misses
    const read = session.revisionOf(item.filename);
    try {
      const revision = await typedInvoke("restore_note_version", {
        filename: item.filename,
        id,
        client: await getDeviceSignals(),
        revision: read ?? null,
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
      if (read === undefined) {
        session.forgetRevision(item.filename);
      } else {
        session.setRevision(item.filename, read);
      }
    }
    await refetchNotes();
    refreshVersions();
    shell.showToast(shown ? t().codex.restored : t().codex.restoredNotShown);
  };

  // Whatever way the writing screen was reached, the panel does not stay beside it
  createEffect(
    on(writing, (entered) => {
      if (entered) {
        closePanel();
      }
    }),
  );

  /** The note the cursor was last handed to. Once per opening, not on every reload. */
  let focusedFor: string | undefined;

  // Entering the writing screen (a promotion, a new note, Enter in the viewer) hands the note
  // over ready to write in as soon as the body arrives
  createEffect(() => {
    if (!writing()) {
      focusedFor = undefined;
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
    focusBody();
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

  /** What compare mode calls itself: "comparing version 2, 3 added, 1 removed, read-only" */
  const compareLine = (): string[] => {
    const row = selectedRow();
    return row
      ? [t().codex.comparing(row.number), compareDetail(), t().notes.readOnly].filter(Boolean)
      : [];
  };

  /** Whether "commit a version" is worth offering: the draft has moved on. */
  const canCommit = (): boolean => {
    const status = versionStatus();
    return (
      kind() === "codex" && loaded() && status !== undefined && (status.dirty || status.count === 0)
    );
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
   * (they mark the key as handled), the confirmation is corvu's, then the history. The last
   * layer is the writing screen, which gives way to the viewer. The settings tab stays: the
   * panel was put there on purpose, like the list.
   */
  const onEscape = (e: KeyboardEvent): void => {
    // corvu folds its dialog on the same keydown before this runs, so `confirmOpen` is already
    // false by then; where the key came from is what still says it was the dialog's
    const fromDialog = e.target instanceof Element && e.target.closest("[role='dialog']") !== null;
    if (confirmOpen() || fromDialog) {
      return;
    }
    if (historyOpen()) {
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
   * Enter or e in the viewer opens the writing screen. Not when the key belongs to something
   * else: a field, a focused button or link, or the palette (AppLayout closes it on the same Esc
   * this handler sees next, so its target is what tells).
   */
  const isWriteKey = (e: KeyboardEvent): boolean => {
    if (writing() || e.metaKey || e.ctrlKey || e.altKey || isImeComposing(e)) {
      return false;
    }
    if (e.key !== "Enter" && e.key !== "e") {
      return false;
    }
    const target = e.target instanceof Element ? e.target : null;
    return !isTypingTarget(e.target) && !target?.closest("button, a, [role='dialog']");
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
      if (isWriteKey(e)) {
        e.preventDefault();
        startWriting();
        return;
      }
      const typing = isTypingTarget(e.target);
      const step = matchesShortcut(e, "notePrev") ? -1 : Number(matchesShortcut(e, "noteNext"));
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
      if (matchesShortcut(e, "noteActions")) {
        e.preventDefault();
        togglePanel();
      } else if (matchesShortcut(e, "noteMap")) {
        e.preventDefault();
        void toggleMap(item);
      } else if (matchesShortcut(e, "noteRevert")) {
        e.preventDefault();
        void revertEdit(item);
      } else if (matchesShortcut(e, "noteInfo")) {
        e.preventDefault();
        openSettings(true);
      } else if (matchesShortcut(e, "codexCommit")) {
        e.preventDefault();
        void commitVersion(item);
      } else if (matchesShortcut(e, "noteHistory") && kind() === "codex") {
        e.preventDefault();
        toggleHistory();
      } else if (e.key === "Escape") {
        onEscape(e);
      }
    };
    globalThis.addEventListener("keydown", onKeyDown);
    onCleanup(() => globalThis.removeEventListener("keydown", onKeyDown));
  });

  /**
   * Up and Down inside the list. It is an action inside the list widget, so it is not on the Cmd
   * table (`SHORTCUTS`) and is taken only inside `.list-scroll`: Up and Down pressed outside the
   * body with nothing selected scroll the page, and that is not taken away.
   * The list has no input field, so no `isTypingTarget` check is needed either.
   *
   * The focus moves first, without awaiting `switchTo`. The feel of the press is not delayed until
   * the save finishes. The row's background catches up when `selectedId` changes.
   */
  const onListKeyDown = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) {
      return;
    }
    const step = LIST_STEP_KEYS[e.key];
    if (step === undefined) {
      return;
    }
    // At an end, do nothing. preventDefault is not called either, so it falls to the list scroll
    const next = stepNote(visibleItems(), selected()?.id, step);
    if (!next) {
      return;
    }
    e.preventDefault();
    const row = listScrollRef?.querySelector<HTMLElement>(`[data-id="${CSS.escape(next)}"]`);
    row?.focus();
    row?.scrollIntoView({ block: "nearest" });
    openInViewer();
    void switchTo(next);
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
   * On a touch device a long press is the entry to templates. A tap still makes an empty note, so
   * "open and write at once" does not cost one more step.
   */
  const newNoteLongPress = createLongPress(() => {
    if (kind() === "note") {
      shell.togglePopover("new-note-menu", newNoteButton);
    }
  });
  let newNotePointer = "mouse";

  /**
   * Moves a Note into Codex's store. Neither the ID nor the body changes, only the surface.
   * There is no way back, so it is not an Undo; the menu's confirmation takes that role.
   * It lands on the surface it moved to: it leaves this surface's list, so staying would fall
   * back to the first note and look like it vanished.
   */
  const promoteToCodex = async (item: NoteItem): Promise<void> => {
    shell.closePopovers();
    await session.settleWrites();
    try {
      await typedInvoke("promote_note_to_codex", { filename: item.filename });
    } catch {
      // Nothing moved, so it stays on the note it was pressed on
      shell.showToast(t().codex.promoteFailed);
      return;
    }
    await refetchNotes();
    // Scrawl's origin chips are derived from the list too. The link survives the change of
    // surface, so make that side reread as well
    shell.refreshData();
    navigate(noteRoute("codex", item.filename));
    shell.showToast(t().codex.promoted);
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
          // The note is still on disk. Kept hidden it would read as deleted until the next
          // start, so its row comes back. The selection stays where the person has gone since
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

  /** The panel's name, which is also what its toggle and the phone's meta line say. */
  const panelLabel = (): string => (kind() === "codex" ? t().codex.panel : t().notes.panel);

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
      onBack={() => setPanelScreen(false)}
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
      metaError={Boolean(noteMeta.error)}
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
      onPromote={() => setConfirmOpen(true)}
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
              // On a phone the body is where a version is compared
              if (screen) {
                setPanelScreen(false);
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

  /**
   * Whether to show the flyout. While not one note is open it stays out: folding with nothing to
   * hide (the body) would leave a screen with nothing on it until the pointer finds the edge.
   */
  const flyoutOpen = (): boolean => shell.listOpen() || selected() === undefined;

  const pinLabel = (): string =>
    shell.listPinned()
      ? t().notes.unpinList(shortcutLabel("listPin"))
      : t().notes.pinList(shortcutLabel("listPin"));

  return (
    <div class="workspace workspace--flyout" classList={{ "workspace--detail": detailOpen() }}>
      {/* Nothing to see: resting the pointer on the window's left edge opens the list */}
      <div
        class="list-edge"
        aria-hidden="true"
        onPointerEnter={() => shell.setListHover(true)}
        onPointerLeave={() => shell.setListHover(false)}
      />
      <div
        class="list-pane"
        classList={{ "list-pane--open": flyoutOpen() }}
        onPointerEnter={() => shell.setListHover(true)}
        onPointerLeave={() => shell.setListHover(false)}
      >
        <div class="list-pane-head">
          <span class="list-pane-title">
            {MODE_LABELS[kind() === "codex" ? ROUTES.CODEX : ROUTES.NOTES]}
          </span>
          <div class="list-pane-actions">
            {/* No badge on the Codex surface. What Cmd-N makes is a Note, and pressing it moves
                to Notes. This button makes one on the surface you are on, so typing what the
                badge says would create a different thing in a different place */}
            <button
              type="button"
              class="new-note long-press"
              ref={newNoteButton}
              aria-expanded={shell.popover() === "new-note-menu"}
              data-hint-key={kind() === "codex" ? undefined : shortcutLabel("newNote")}
              onPointerDown={(e) => {
                newNotePointer = e.pointerType;
                newNoteLongPress.onPointerDown(e);
              }}
              onPointerUp={newNoteLongPress.onPointerUp}
              onPointerMove={newNoteLongPress.onPointerMove}
              onPointerCancel={newNoteLongPress.onPointerCancel}
              onContextMenu={newNoteLongPress.onContextMenu}
              onClick={() => {
                // Swallow the click right after a long press opened the menu
                if (!newNoteLongPress.shouldClick()) {
                  return;
                }
                // Templates are a Note entry. On the Codex surface it only makes one empty note:
                // `create_from_template` cannot choose the store
                if (newNotePointer === "mouse" && kind() === "note") {
                  shell.togglePopover("new-note-menu", newNoteButton);
                } else {
                  void createNote();
                }
              }}
            >
              <Icon name="plus" size={12} />
              {t().notes.new}
            </button>
            {/* The pin belongs inside the list, so it can be pressed only while the list is open.
              The same thing can be done with Cmd-\ */}
            <button
              type="button"
              class="list-pin"
              aria-pressed={shell.listPinned()}
              title={pinLabel()}
              aria-label={pinLabel()}
              data-hint-key={shortcutLabel("listPin")}
              onClick={() => shell.toggleListPin()}
            >
              <Icon name={shell.listPinned() ? "push-pin-fill" : "push-pin"} size={14} />
            </button>
          </div>
        </div>

        <Popover
          open={shell.popover() === "new-note-menu"}
          onClose={() => shell.closePopovers()}
          trigger={shell.popoverTrigger}
          label={t().templates.newNote}
        >
          {/* The back is darkened only for the sheet that comes up from the bottom (CSS decides
              which). Closing is taken here: this curtain sits inside the container, so to the
              component a press on it is an inside press and never "pressed outside". The sheet
              has no cancel button and the curtain covers the button that opened it as well, so
              without taking it there is no way out with a finger alone */}
          <div
            class="template-picker-backdrop"
            aria-hidden="true"
            onClick={() => shell.closePopovers()}
          />
          <TemplatePicker
            templates={templates() ?? []}
            onPickEmpty={() => {
              shell.closePopovers();
              void createNote();
            }}
            onPick={(template) => {
              void createFromTemplate(template);
            }}
            onManage={() => {
              shell.closePopovers();
              navigate(ROUTES.TEMPLATES);
            }}
          />
        </Popover>

        {/* The keys are taken by the rows inside (button); this only bundles them.
            Like `.detail-body`, a container that claims no role */}
        <div class="list-scroll" ref={listScrollRef} role="presentation" onKeyDown={onListKeyDown}>
          <Show when={groups().length} fallback={<EmptyNotes kind={kind()} />}>
            <For each={groups()}>
              {(group) => (
                <>
                  <div class="list-group-label">{group.label}</div>
                  <For each={group.items}>
                    {(item) => (
                      <button
                        type="button"
                        class="list-row"
                        data-id={item.id}
                        classList={{
                          "list-row--selected": selected()?.id === item.id,
                          "list-row--codex": kind() === "codex",
                        }}
                        onClick={() => select(item as NoteItem)}
                      >
                        <span class="list-row-title">{itemTitle(item)}</span>
                        {/* Only a Codex row puts the version count on a folded-corner page. The
                            first of the differences from Note */}
                        <Show when={kind() === "codex"}>
                          <PageMark
                            count={(item as NoteItem).versionCount ?? 0}
                            dirty={(item as NoteItem).dirty ?? false}
                          />
                        </Show>
                        <span class="list-row-stamp">{noteRowStamp(item as NoteItem, today)}</span>
                      </button>
                    )}
                  </For>
                </>
              )}
            </For>
          </Show>
        </div>

        {/* The rule for opening and closing is written at the foot, only while it is open */}
        <div class="list-pane-foot">
          {shell.listPinned()
            ? t().notes.listPinnedHint(shortcutLabel("listPin"))
            : t().notes.listHint(shortcutLabel("listPin"))}
        </div>
      </div>

      <div
        class="detail-pane"
        classList={{
          // While the history is open the map is not drawn. Keeping only the width would narrow it
          // by a map that has no title row, so it would stop lining up with the body column
          "detail-pane--map": mapShown(),
          // Docked, the panel takes its 320px from the body; floating, it lies over it
          "detail-pane--panel": selected() !== undefined && twoPane() && shell.notePanelPinned(),
        }}
      >
        <Show when={selected()} fallback={<div class="detail-empty">{t().notes.noSelection}</div>}>
          {(item) => (
            <>
              {/* On a phone the panel swaps with the body. In a wide window it only stands to
                  the right of the body, so the body stays (NotePanel below) */}
              <Show when={!panelScreenShown()}>
                {/* Title, record and actions in one group. They sit on the same level as the body,
                  so what you want to know about a note is not searched for somewhere far away */}
                {/* The strip over the page. The viewer: back (a phone's) · map · write · tidy.
                    The writing screen: done. Keys live in the titles */}
                <div class="note-strip">
                  <Show
                    when={writing()}
                    fallback={
                      <>
                        <button
                          type="button"
                          class="icon-button detail-back"
                          aria-label={t().notes.backToList}
                          onClick={() => {
                            void session.settleEdit();
                            setDetailOpen(false);
                          }}
                        >
                          <Icon name="arrow-left" size={18} />
                        </button>
                        <span class="note-strip-fill" />
                        <button
                          type="button"
                          class="icon-button"
                          aria-pressed={mapOpen()}
                          title={`${t().notes.map} ${shortcutLabel("noteMap")}`}
                          aria-label={t().notes.map}
                          onClick={() => {
                            void toggleMap(item());
                          }}
                        >
                          <Icon name="tree-structure" size={17} />
                        </button>
                        <button
                          type="button"
                          class="icon-button"
                          title={`${t().viewer.write} ↵`}
                          aria-label={t().viewer.write}
                          disabled={historyOpen()}
                          onClick={startWriting}
                        >
                          <Icon name="pencil" size={17} />
                        </button>
                      </>
                    }
                  >
                    <button
                      type="button"
                      class="icon-button"
                      title={`${t().viewer.done} Esc`}
                      aria-label={t().viewer.done}
                      onClick={stopWriting}
                    >
                      <Icon name="check" size={17} />
                    </button>
                    <span class="note-strip-fill" />
                  </Show>
                  {/* The one visible way into the panel; ⌘. is the other. Neither works while
                    writing: nothing interrupts the writing hand */}
                  <Show when={!writing()}>
                    <button
                      type="button"
                      class="icon-button note-panel-toggle"
                      aria-expanded={shell.notePanelPinned()}
                      title={`${t().viewer.tidy} ${shortcutLabel("noteActions")}`}
                      aria-label={panelLabel()}
                      data-hint-key={shortcutLabel("noteActions")}
                      onClick={togglePanel}
                    >
                      <Icon name="dots-three" size={18} />
                    </button>
                  </Show>
                </div>

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

                  {/* The phone's state row. A wide window says the same in the dot's details, so it
                    is hidden there (CSS) */}
                  <div class="detail-status-row">
                    <Show when={saveStatus() !== "idle"}>
                      <span class="detail-save-status" data-status={saveStatus()}>
                        <Show when={saveStatus() === "saving"}>
                          <Icon name="circle-notch" size={11} />
                        </Show>
                        <Show when={saveStatus() === "saved"}>
                          <Icon name="check" size={11} />
                        </Show>
                        {saveStatus() === "saving" ? t().common.saving : null}
                        {saveStatus() === "saved" ? t().common.saved : null}
                        {saveStatus() === "savedAt" ? t().notes.savedAt(savedAt()) : null}
                        {saveStatus() === "failed" ? t().status.saveFailed : null}
                      </span>
                    </Show>
                    <Show when={mapShown()}>
                      <button
                        type="button"
                        class="detail-state-pill"
                        onClick={() => openSettings()}
                      >
                        <Icon name="tree-structure" size={12} />
                        {t().notes.map}
                      </button>
                    </Show>
                    <Show when={examplesShown() && item().template !== undefined}>
                      <button
                        type="button"
                        class="detail-state-pill"
                        onClick={() => openSettings()}
                      >
                        <Icon name="file-text" size={12} />
                        {t().notes.examples}
                      </button>
                    </Show>
                    <span class="detail-status-actions">
                      <Show when={canCommit()}>
                        <button
                          type="button"
                          class="detail-action-pill"
                          onClick={() => {
                            void commitVersion(item());
                          }}
                        >
                          <Icon name="book-bookmark" size={13} />
                          {t().codex.commit}
                        </button>
                      </Show>
                      <Show when={canRevert()}>
                        <button
                          type="button"
                          class="detail-action-pill"
                          onClick={() => {
                            void revertEdit(item());
                          }}
                        >
                          <Icon name="arrow-counter-clockwise" size={13} />
                          {t().notes.revert}
                        </button>
                      </Show>
                    </span>
                  </div>
                </div>

                <div class="detail-panes" classList={{ "detail-panes--map": mapShown() }}>
                  {/* For biome-ignore/eslint: what is caught here is only a note link with no
                    href. Writing actions are taken by the editor itself */}
                  <div
                    class="detail-body"
                    data-view={historyOpen() ? "history" : noteView()}
                    ref={detailBodyRef}
                    role="presentation"
                    onClick={onBodyClick}
                    // The viewer's third way into writing, beside Enter and e
                    onDblClick={() => {
                      if (!writing()) {
                        startWriting();
                      }
                    }}
                  >
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

                {/* The compare mode strip. What is being compared, and the three ways out of it
                  (back to the history, restore that version, leave compare). Phones only */}
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
                      class="button-secondary"
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
                      class="icon-button compare-bar-close"
                      aria-label={t().codex.close}
                      onClick={closePanel}
                    >
                      <Icon name="x" size={16} />
                    </button>
                  </div>
                </Show>
              </Show>

              {/* A phone's panel is its own screen, swapped in for the body. Pressing a version
                  on its history tab returns to the body, with the compare bar attached */}
              <Show when={panelScreenShown()}>{notePanel(item, true)}</Show>

              {/* In a wide window, 320px at the right edge. It exists even when folded, so
                  opening and closing read as a 220ms slide */}
              <Show when={twoPane()}>{notePanel(item, false)}</Show>

              <PromoteDialog
                open={confirmOpen()}
                icon="book"
                title={t().codex.promote}
                // Say what is gained before saying there is no way back. That is what decides
                // whether to press
                body={
                  <>
                    {t().codex.promoteConfirm}
                    <strong>{t().codex.promoteConfirmStrong}</strong>
                    {t().codex.promoteConfirmEnd}
                  </>
                }
                yes={t().codex.promoteYes}
                no={t().codex.promoteNo}
                onClose={() => setConfirmOpen(false)}
                onConfirm={() => {
                  setConfirmOpen(false);
                  void promoteToCodex(item());
                }}
              />
            </>
          )}
        </Show>
      </div>

      {/* The entry for notation that is hard to type on a keyboard. It appears on touch devices
          only. It is lazy, so drawing it unconditionally would load the whole editor just from
          looking at the list. It is drawn only once the editor is up */}
      <Show when={markdownEditor()}>{(editor) => <MarkdownToolbar editor={editor()} />}</Show>
    </div>
  );
}
