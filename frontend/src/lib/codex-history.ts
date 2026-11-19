/**
 * A Codex's history: the open note's versions, the one the draft is compared with, and
 * committing the next one. The history tab is compare mode itself, so whether it is open is
 * also whether the body on screen reads as a version's diff.
 *
 * Kept apart from the view because all of it hangs off one question, "which version is the draft
 * held against", and none of it decides how the body is drawn. The view keeps where the history
 * appears (the panel, the phone's screen, the compare bar) and restoring, which replaces the body
 * on screen and so belongs with the other paths that do. It also keeps the edit session: a version
 * is cut from the body on disk, and only the view knows when that has caught up with the screen,
 * so `enter` and `commit` are called once the in-flight save has landed.
 */

import { batch, createEffect, createMemo, createResource, createSignal } from "solid-js";
import type { Accessor, Setter } from "solid-js";
import { typedInvoke } from "./commands";
import type { NoteKind, VersionStatus } from "./commands";
import { diffLineCounts, markedBody } from "./diff-marks";
import type { MarkedBody } from "./diff-marks";
import { t } from "./i18n";
import { daysSince, spanSince, withDeltas } from "./versions";
import type { VersionRow } from "./versions";

/** How long a just-committed version pops (`mm-pop`). Past that the row goes back to normal. */
const POP_MS = 350;

/** What the history reads of a note. Versions are filed under its filename. */
interface HistoryTarget {
  filename: string;
}

export interface CodexHistoryDeps {
  kind: () => NoteKind;
  selected: () => HistoryTarget | undefined;
  /** Whether the body on screen is the selected note's. A commit is not offered before it is. */
  loaded: () => boolean;
  /** The body on screen, title joined in. The gutter marks are laid over it. */
  body: () => string;
  /** Rereads the list: a Codex row's folded-corner page counts the versions. */
  refreshList: () => unknown;
  showToast: (text: string, undo?: () => void, detail?: string) => void;
}

export interface CodexHistory {
  /**
   * Whether the history is open, that is compare mode. Codex only. The body turns read-only and
   * the difference from the chosen version becomes gutter marks; the body never disappears.
   * In a wide window it is also which tab the right panel shows: the history tab is open
   * exactly while this is on, so the two cannot disagree.
   */
  open: Accessor<boolean>;
  setOpen: Setter<boolean>;
  /** The version chosen in the history. The newest one the moment it opens. */
  selectedVersionId: Accessor<string | null>;
  setSelectedVersionId: Setter<string | null>;
  /** The version just committed. Only that row in the history pops as it enters. */
  freshId: Accessor<string | null>;
  /** The version count and how far the draft has moved from the newest version. */
  status: Accessor<VersionStatus | undefined>;
  /** The versions, newest first, numbered and with their size deltas. */
  rows: Accessor<VersionRow[]>;
  /** The body with the gutter marks applied. Only while the history is open. */
  marked: Accessor<MarkedBody | undefined>;
  /** "committed 4 times in 9 months", the line at the top of the history tab. */
  cadence: () => string | undefined;
  /** The row chosen in the history. It gives the number and decides what to restore to. */
  selectedRow: Accessor<VersionRow | undefined>;
  /** "3 lines added, 1 line removed", or "same content". */
  compareDetail: () => string;
  /** What compare mode calls itself: "comparing version 2, 3 added, 1 removed, read-only" */
  compareLine: () => string[];
  /** Whether "commit a version" is worth offering: the draft has moved on. */
  canCommit: () => boolean;
  /** Rereads the count alone. Every write moves "+X B from version N". */
  refetchStatus: () => unknown;
  /** When versions are added or removed, reread the count, the spine and the list mark together. */
  refresh: () => void;
  /** Opens compare mode on the newest version. */
  enter: () => Promise<void>;
  /** Leaves compare mode. */
  leave: () => void;
  /** Commits the body on disk as a version. */
  commit: (item: HistoryTarget) => Promise<void>;
}

export function createCodexHistory(deps: CodexHistoryDeps): CodexHistory {
  const [open, setOpen] = createSignal(false);
  const [selectedVersionId, setSelectedVersionId] = createSignal<string | null>(null);
  const [freshId, setFreshId] = createSignal<string | null>(null);

  // The version count and "how far it has moved from the newest version". It compares the body
  // against a version, so it reads only the one note that is open (the mark on a list row comes
  // from core using the name fingerprint alone)
  const [status, { refetch: refetchStatus }] = createResource(
    () => (deps.kind() === "codex" ? deps.selected()?.filename : undefined),
    (filename) => typedInvoke("note_version_status", { filename }),
  );
  // The versions themselves. Even folded, the spine dots once per version, so a Codex reads them
  const [versions, { refetch: refetchVersions }] = createResource(
    () => (deps.kind() === "codex" ? deps.selected()?.filename : undefined),
    (filename) => typedInvoke("list_note_versions", { filename }),
  );
  const rows = createMemo<VersionRow[]>(() => withDeltas(versions() ?? []));

  const refresh = (): void => {
    void refetchStatus();
    void refetchVersions();
  };

  // The diff from the chosen version to the draft. Only while the history is open
  const [diff] = createResource(
    () => {
      const id = selectedVersionId();
      const filename = deps.selected()?.filename;
      return open() && id !== null && filename ? { filename, from: id } : undefined;
    },
    (args) => typedInvoke("diff_note_versions", args),
  );

  /**
   * An empty diff (same content) means no marks and the body as it is. Saves are flushed when
   * the history opens, so the body on screen equals disk.
   */
  const marked = createMemo(() => {
    const text = diff();
    return text ? markedBody(deps.body(), text) : undefined;
  });
  /** The span since the first version comes from the list. */
  const cadence = (): string | undefined => {
    const list = rows();
    const oldest = list.at(-1);
    return oldest
      ? t().codex.cadence(list.length, spanSince(oldest.version.time, new Date()))
      : undefined;
  };

  const selectedRow = createMemo<VersionRow | undefined>(() =>
    rows().find((row) => row.version.id === selectedVersionId()),
  );

  /**
   * It counts from the diff compare mode has already read, so showing it adds not one IPC call.
   * Identical content reads as "same content".
   */
  const compareDetail = (): string => {
    const text = diff();
    if (text === undefined) {
      return "";
    }
    const { added, removed } = diffLineCounts(text);
    return added + removed === 0 ? t().codex.sameShort : t().codex.lineDelta(added, removed);
  };

  const compareLine = (): string[] => {
    const row = selectedRow();
    return row
      ? [t().codex.comparing(row.number), compareDetail(), t().notes.readOnly].filter(Boolean)
      : [];
  };

  const canCommit = (): boolean => {
    const current = status();
    return (
      deps.kind() === "codex" &&
      deps.loaded() &&
      current !== undefined &&
      (current.dirty || current.count === 0)
    );
  };

  const enter = async (): Promise<void> => {
    // Versions are committed on other devices too. Opening the compare screen is a cheap moment to
    // reread. The newest version is chosen from the reread list: from the local list, an older one
    // would keep opening as long as it is still in the arriving list, even when a newer one exists
    void refetchStatus();
    const list = (await refetchVersions()) ?? versions();
    batch(() => {
      setSelectedVersionId(list?.[0]?.id ?? null);
      setOpen(true);
    });
  };

  /** The panel stays where it is, on its settings tab. */
  const leave = (): void => {
    batch(() => {
      setOpen(false);
      setSelectedVersionId(null);
    });
  };

  /**
   * This is the only entry, and nothing commits automatically. It hangs on neither save, leave
   * nor promotion: a version is the mark a person puts at "this far".
   *
   * It commits the moment it is pressed. No message is asked for: "version N, date" is enough for
   * a version's name, and asking makes committing itself feel like a chore. Instead a toast says
   * the summary, and during the grace period it can be undone (which only deletes the version's
   * file).
   */
  const commit = async (item: HistoryTarget): Promise<void> => {
    const before = versions() ?? [];
    let version;
    try {
      version = await typedInvoke("commit_note_version", {
        filename: item.filename,
        message: null,
      });
    } catch {
      deps.showToast(t().codex.commitFailed);
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
      setFreshId(version.id);
      setTimeout(() => setFreshId(null), POP_MS);
    }
    refresh();
    // The folded-corner page in the list changes its count and frame too
    void deps.refreshList();
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
            refresh();
            void deps.refreshList();
          })();
        };
    deps.showToast(t().codex.committed(count), undo, summary);
  };

  // If the versions have not arrived when it opens, choose the newest one that arrives. It also
  // moves to the newest when an undo removed the version that was chosen
  createEffect(() => {
    if (!open()) {
      return;
    }
    const list = versions();
    if (!list) {
      return;
    }
    const chosen = selectedVersionId();
    if (chosen === null || !list.some((v) => v.id === chosen)) {
      setSelectedVersionId(list[0]?.id ?? null);
    }
  });

  return {
    open,
    setOpen,
    selectedVersionId,
    setSelectedVersionId,
    freshId,
    status,
    rows,
    marked,
    cadence,
    selectedRow,
    compareDetail,
    compareLine,
    canCommit,
    refetchStatus,
    refresh,
    enter,
    leave,
    commit,
  };
}
