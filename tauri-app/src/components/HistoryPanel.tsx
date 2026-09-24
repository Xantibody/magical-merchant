import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import { t } from "../lib/i18n";
import { isBeforeRestore, versionClock, versionDay, versionMessage } from "../lib/versions";
import type { VersionRow } from "../lib/versions";
import "../styles/history.css";

interface HistoryPanelProps {
  /** Versions, newest first. */
  rows: VersionRow[];
  /** "committed 4 times in 9 months". The surface does the counting. Absent with no versions. */
  summary?: string;
  /** Whether the draft has moved on from the latest version. */
  dirty: boolean;
  /** Byte difference between the draft and the latest version. */
  bytesDelta: number;
  /**
   * Whether it is shown on the phone's panel screen. The rows grow to a finger's size, and
   * restoring belongs to the compare bar under the body.
   */
  screen?: boolean;
  /** The version selected in the history. */
  selectedId: string | null;
  /** A read-only note cannot be restored. */
  readOnly: boolean;
  /** The version just committed. Only its row pops in. */
  freshId?: string | null;
  onSelect: (id: string) => void;
  onRestore: (id: string) => void;
  onCommit: () => void;
}

/** Direction the up/down keys step through the version rows. */
const ROW_STEP_KEYS: Readonly<Record<string, 1 | -1>> = { ArrowUp: -1, ArrowDown: 1 };

/** Dot kinds. The draft is hollow, the emphasised one (selected or latest) a large fill, the rest small and faint. */
function Dot(props: { kind: "draft" | "strong" | "faint" }): JSX.Element {
  return <span class="history-dot" data-kind={props.kind} />;
}

/** The date and time at the right edge of a row. "08/12 22:18" */
function stamp(row: VersionRow): string {
  return `${versionDay(row.version)} ${versionClock(row.version)}`;
}

/**
 * The second line of a row. The oldest version reads "first version, 2.1 KB";
 * the others show the byte difference from the version one older. Line counts
 * are not shown: reading two bodies per version costs more than what it would be
 * worth paying on every open (the compare bar and the meta line give the line
 * count of the version being compared).
 */
function delta(row: VersionRow): string {
  return [
    versionMessage(row.version, t().codex.beforeRestore),
    row.number === 1
      ? t().codex.firstVersion(row.version.bytes)
      : t().codex.deltaFromLatest(row.number - 1, row.delta),
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The history opened on a Codex with zero versions. Instead of showing an empty
 * list, the next move (commit a version) is placed here.
 */
function NoVersions(props: { onCommit: () => void }): JSX.Element {
  return (
    <div class="history-empty">
      <p class="history-empty-hint">{t().codex.noVersionsHint}</p>
      <button type="button" class="button-secondary" onClick={() => props.onCommit()}>
        <Icon name="book-bookmark" size={14} />
        {t().codex.commit}
      </button>
    </div>
  );
}

/**
 * The list of versions: the body of the right panel's history tab (`NotePanel`).
 * The tab row names it and the panel decides where it stands, so this holds only a
 * summary line, the draft and version rows, and the next move when there are none.
 *
 * It does not open on hover. Only the panel's history tab, ⌘⇧H and the bottom bar
 * reach it: 320px of comparison must not appear in passing beside a hand that is
 * writing the body.
 *
 * Rows run from the draft at the top, then the latest, down to the oldest. The
 * line under each dot stretches the height of its row to join the next dot.
 */
export default function HistoryPanel(props: HistoryPanelProps): JSX.Element {
  const emphasis = (row: VersionRow, index: number): "strong" | "faint" => {
    const chosen = props.selectedId === null ? index === 0 : row.version.id === props.selectedId;
    return chosen ? "strong" : "faint";
  };

  /** Up/down moves to the neighbouring version. Same idea as the list rows; handled only in here. */
  const onKeyDown = (e: KeyboardEvent): void => {
    const step = ROW_STEP_KEYS[e.key];
    if (step === undefined || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) {
      return;
    }
    const index = props.rows.findIndex((row) => row.version.id === props.selectedId);
    const next = props.rows[index + step];
    if (!next) {
      return;
    }
    e.preventDefault();
    props.onSelect(next.version.id);
    (e.currentTarget as HTMLElement)
      .querySelector<HTMLElement>(`[data-id="${CSS.escape(next.version.id)}"]`)
      ?.focus();
  };

  return (
    <div class="history-panel" classList={{ "history-panel--screen": props.screen }}>
      <Show when={props.summary}>
        {(summary) => <div class="history-summary">{summary()}</div>}
      </Show>

      <Show when={props.rows.length > 0} fallback={<NoVersions onCommit={props.onCommit} />}>
        {/* The rows inside receive the keys. This only bundles them */}
        <div class="history-list" role="presentation" onKeyDown={onKeyDown}>
          {/* The draft is what a version is compared against, not a candidate. Its row
              shows but cannot be selected */}
          <div class="history-row history-row--draft">
            <span class="history-row-rail">
              <Dot kind="draft" />
              <span class="history-rail-line" data-dashed="" />
            </span>
            <span class="history-row-text">
              <span class="history-row-line1">
                {t().codex.draft}
                <span class="history-row-delta" data-moved={props.dirty ? "" : undefined}>
                  {props.dirty ? t().codex.sizeDelta(props.bytesDelta) : t().codex.sameShort}
                </span>
              </span>
              <span class="history-row-line2">
                {props.dirty
                  ? t().codex.nextVersion(props.rows.length + 1)
                  : t().codex.sameAsVersion(props.rows.length)}
              </span>
            </span>
          </div>

          <For each={props.rows}>
            {(row, index) => (
              <>
                <button
                  type="button"
                  class="history-row"
                  classList={{ "history-row--fresh": row.version.id === props.freshId }}
                  data-id={row.version.id}
                  aria-current={row.version.id === props.selectedId}
                  onClick={() => props.onSelect(row.version.id)}
                >
                  <span class="history-row-rail">
                    <Dot kind={emphasis(row, index())} />
                    <Show when={index() < props.rows.length - 1}>
                      <span class="history-rail-line" />
                    </Show>
                  </span>
                  <span class="history-row-text">
                    <span class="history-row-line1">
                      {t().codex.versionN(row.number)}
                      <span class="history-row-stamp">
                        {isBeforeRestore(row.version) ? versionClock(row.version) : stamp(row)}
                      </span>
                    </span>
                    <span class="history-row-line2">{delta(row)}</span>
                  </span>
                </button>
                {/* Restoring acts on the one selected version. It sits under the
                    row so that which version it restores cannot be mistaken. On a
                    phone the compare bar holds it */}
                <Show when={!props.screen && row.version.id === props.selectedId}>
                  <div class="history-restore">
                    <button
                      type="button"
                      class="button-secondary"
                      disabled={props.readOnly}
                      onClick={() => props.onRestore(row.version.id)}
                    >
                      <Icon name="arrow-counter-clockwise" size={13} />
                      {t().codex.restoreN(row.number)}
                    </button>
                  </div>
                </Show>
              </>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
