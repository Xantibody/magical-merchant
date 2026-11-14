import { createSignal, Show } from "solid-js";
import type { JSX } from "solid-js";
import HoldButton from "./HoldButton";
import Icon from "./Icon";
import type { IconName } from "./Icon";
import type { NoteKind, NoteMeta } from "../lib/commands";
import { t } from "../lib/i18n";
import { contextRows, formatRecordedAt, toDatetimeLocal } from "../lib/note-meta";
import { shortcutLabel } from "../lib/shortcuts";
import type { ShortcutName } from "../lib/shortcuts";
import "../styles/note-panel.css";

/** Which tab the panel shows. Only a Codex has the second one. */
export type NotePanelTab = "note" | "history";

interface NotePanelProps {
  kind: NoteKind;
  /**
   * Whether it is a phone's sheet, rising from the foot over the note. Otherwise it is the
   * 320px panel at the right edge.
   */
  screen?: boolean;
  /** The note's title. Only the phone's sheet shows it, at its head. */
  title: string;
  /** Whether the panel is on screen. The screen is on screen whenever it is mounted. */
  open: boolean;
  tab: NotePanelTab;
  /** The version count beside the history tab. */
  historyCount: number;
  onTab: (tab: NotePanelTab) => void;

  mapOpen: boolean;
  /** Whether the note has template examples. The switch is not shown for one that has none. */
  hasExamples: boolean;
  examplesShown: boolean;
  onToggleMap: () => void;
  onToggleExamples: () => void;

  detailsOpen: boolean;
  onToggleDetails: () => void;
  /** The frontmatter, read only while the details are open. */
  meta?: NoteMeta;
  metaError?: boolean;
  /** A new created time, as the datetime-local input gave it. */
  onEditTime: (value: string) => void;
  /**
   * The tag section. A function, so the editor is built once where it is placed rather than on
   * every read of the prop.
   */
  tags: () => JSX.Element;

  canRevert: boolean;
  /** Why revert cannot be pressed. Absent when there is nothing worth saying. */
  revertHint?: string;
  onRevert: () => void;
  /** Note only. Runs once the press has been held (96): there is no way back from it. */
  onPromote: () => void;
  /** Codex only. */
  onCommit: () => void;
  /** How far the draft has moved since the newest version, carried on the commit itself (92). */
  commitDelta?: string;
  /** Held too: the note goes (an undo stands for 5 s after). */
  onDelete: () => void;
  /** The page alone (85): the same as two fingers tapped twice, for a hand that wants a switch. */
  paper: boolean;
  onTogglePaper: () => void;
  /**
   * The phone's sheet only: the line under its title, still in sight at the sheet's first stop
   * (a Codex's version, or what is being compared).
   */
  summary?: JSX.Element;
  /** The history tab's body (`HistoryPanel`). */
  history: JSX.Element;
}

/** One row of the `表示` group. The switch is a checkbox, so the screen reader says its state. */
function SwitchRow(props: {
  icon: IconName;
  size: number;
  label: string;
  checked: boolean;
  shortcut?: ShortcutName;
  onToggle: () => void;
}): JSX.Element {
  return (
    <label class="note-panel-row note-panel-switch">
      <Icon name={props.icon} size={props.size} />
      <span class="note-panel-row-label">{props.label}</span>
      <Show when={props.shortcut}>
        {(name) => (
          <span class="note-panel-key" aria-hidden="true">
            {shortcutLabel(name())}
          </span>
        )}
      </Show>
      <input
        type="checkbox"
        role="switch"
        aria-checked={props.checked}
        checked={props.checked}
        onChange={(e) => {
          // The note decides the state. Left to the checkbox, a refused write would leave it on
          e.currentTarget.checked = props.checked;
          props.onToggle();
        }}
      />
      <span class="switch" aria-hidden="true" />
    </label>
  );
}

/**
 * The created time. It is the one record a person may move, so it reads as text and becomes
 * an input only when pressed: an input standing there all the time says "fill me in".
 */
function CreatedField(props: { time: string; onEdit: (value: string) => void }): JSX.Element {
  const [editing, setEditing] = createSignal(false);
  return (
    <Show
      when={editing()}
      fallback={
        <button type="button" class="note-panel-created" onClick={() => setEditing(true)}>
          {formatRecordedAt(props.time)}
        </button>
      }
    >
      <input
        type="datetime-local"
        class="note-panel-created-input"
        aria-label={t().meta.created}
        value={toDatetimeLocal(props.time)}
        ref={(el) => queueMicrotask(() => el.focus())}
        onChange={(e) => props.onEdit(e.currentTarget.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            // The panel's own way out comes next. This press only puts the text back
            e.preventDefault();
            setEditing(false);
          }
        }}
      />
    </Show>
  );
}

/**
 * Everything that acts on one note: the three view switches, the record, and the rare
 * actions. It replaced the `…` menu, which hid all of this behind a 29px glyph and showed
 * none of the state.
 *
 * On a wide window it is 320px at the right edge, beside the body. The strip's … and ⌘. are
 * the only ways in. A Codex adds the history as a second tab of the same slot. On a phone it is
 * a sheet that rises from the foot over the body.
 */
export default function NotePanel(props: NotePanelProps): JSX.Element {
  const label = (): string => (props.kind === "codex" ? t().codex.panel : t().notes.panel);
  /** A phone's rows are 48px, and their icons grow with them. */
  const iconSize = (): number => (props.screen ? 18 : 15);

  const tabs = (): JSX.Element => (
    <div class="note-panel-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        class="note-panel-tab"
        aria-selected={props.tab === "note"}
        onClick={() => props.onTab("note")}
      >
        {t().codex.panel}
      </button>
      <button
        type="button"
        role="tab"
        class="note-panel-tab"
        aria-selected={props.tab === "history"}
        data-hint-key={props.screen ? undefined : shortcutLabel("noteHistory")}
        onClick={() => props.onTab("history")}
      >
        {t().codex.history}
        <span class="note-panel-tab-count">{props.historyCount}</span>
      </button>
    </div>
  );

  const environment = (): string =>
    props.meta
      ? contextRows(props.meta.context, props.meta.source)
          .map((row) => row.value)
          .join(" · ")
      : "";

  const settings = (): JSX.Element => (
    <div class="note-panel-settings">
      <Show when={props.tags}>
        {(render) => (
          // The shape says what a section is (ADR 0013). The heading left the screen, not the
          // screen reader: the groups keep the names it used to give
          <div class="note-panel-tags" role="group" aria-label={t().common.tags}>
            {render()()}
          </div>
        )}
      </Show>
      <div role="group" aria-label={t().notes.view}>
        <SwitchRow
          icon="tree-structure"
          size={iconSize()}
          label={t().notes.map}
          checked={props.mapOpen}
          shortcut={props.screen ? undefined : "noteMap"}
          onToggle={props.onToggleMap}
        />
        {/* Not shown for a note without examples. A switch that changes nothing when pressed
            only tells the reader "it did not work" */}
        <Show when={props.hasExamples}>
          <SwitchRow
            icon="file-text"
            size={iconSize()}
            label={t().notes.examples}
            checked={props.examplesShown}
            onToggle={props.onToggleExamples}
          />
        </Show>
        <SwitchRow
          icon="corners-out"
          size={iconSize()}
          label={t().palm.paper}
          checked={props.paper}
          onToggle={props.onTogglePaper}
        />
      </div>

      <div>
        {/* AIDEV-NOTE: this word stays while the other headings went. It is the control that
            opens the details, which are read only when asked for, not a label over them */}
        <button
          type="button"
          class="note-panel-row note-panel-disclosure"
          aria-expanded={props.detailsOpen}
          onClick={() => props.onToggleDetails()}
        >
          <Icon name={props.detailsOpen ? "caret-down" : "caret-right"} size={10} />
          {t().notes.details}
        </button>
        <Show when={props.detailsOpen}>
          <Show
            when={!props.metaError}
            fallback={<p class="note-panel-hint">{t().meta.unreadable}</p>}
          >
            <Show when={props.meta}>
              {(meta) => (
                <dl class="note-panel-details">
                  <dt>{t().meta.created}</dt>
                  <dd>
                    <CreatedField time={meta().time} onEdit={props.onEditTime} />
                  </dd>
                  {/* The updated time is the record of when it was rewritten. A record that can
                      be moved by hand is no record, so it is read-only */}
                  <Show when={meta().updated}>
                    {(updated) => (
                      <>
                        <dt>{t().meta.updated}</dt>
                        <dd>{formatRecordedAt(updated())}</dd>
                      </>
                    )}
                  </Show>
                  <Show when={environment()}>
                    <dt>{t().meta.environment}</dt>
                    <dd>{environment()}</dd>
                  </Show>
                </dl>
              )}
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );

  const actions = (): JSX.Element => (
    <div class="note-panel-actions">
      {/* The arrow that rewinds one step. The clock arrow belongs to the history */}
      <button
        type="button"
        class="note-panel-row note-panel-action"
        disabled={!props.canRevert}
        onClick={() => props.onRevert()}
      >
        <Icon name="arrow-counter-clockwise" size={iconSize()} />
        <span class="note-panel-row-label">{t().notes.revert}</span>
        <span class="note-panel-key" aria-hidden="true">
          {shortcutLabel("noteRevert")}
        </span>
      </button>
      <Show when={!props.canRevert && props.revertHint}>
        {(hint) => <p class="note-panel-hint note-panel-action-hint">{hint()}</p>}
      </Show>
      <Show when={props.kind === "codex"}>
        <button
          type="button"
          class="note-panel-row note-panel-action"
          onClick={() => props.onCommit()}
        >
          <Icon name="book-bookmark" size={iconSize()} />
          <span class="note-panel-row-label">{t().codex.commit}</span>
          {/* How far the draft has moved, on the button that would commit it (92) */}
          <Show when={props.commitDelta}>
            {(delta) => <span class="note-panel-delta">{delta()}</span>}
          </Show>
          <span class="note-panel-key" aria-hidden="true">
            {shortcutLabel("codexCommit")}
          </span>
        </button>
      </Show>
      {/* The two that cannot be taken back in the same way are held, not confirmed (96): the
          question and its answer are one press, and nothing opens over the note */}
      <div class="note-panel-holds">
        <Show when={props.kind === "note"}>
          <HoldButton
            class="note-panel-hold"
            label={t().codex.promote}
            hint={t().palm.holdPromote}
            icon="book"
            onConfirm={() => props.onPromote()}
          />
        </Show>
        <HoldButton
          class="note-panel-hold"
          label={t().common.delete}
          hint={t().palm.holdDelete}
          icon="trash"
          danger
          onConfirm={() => props.onDelete()}
        />
      </div>
      <Show when={props.kind === "note"}>
        <p class="note-panel-hint note-panel-action-hint">{t().codex.promoteSub}</p>
      </Show>
    </div>
  );

  /**
   * A phone's actions, one row standing at the foot of the sheet's visible part whatever stop
   * it rests at: the thumb finds them where it already is, and the middle stop no longer hides
   * the commit below the screen. Short words, one row; the full names are the wide panel's.
   */
  const footActions = (): JSX.Element => (
    <div class="note-panel-foot-row">
      <button
        type="button"
        class="note-panel-foot-action"
        disabled={!props.canRevert}
        title={props.canRevert ? t().notes.revert : (props.revertHint ?? t().notes.revert)}
        aria-label={t().notes.revert}
        onClick={() => props.onRevert()}
      >
        <Icon name="arrow-counter-clockwise" size={15} />
        {t().reach.revertShort}
      </button>
      <Show
        when={props.kind === "codex"}
        fallback={
          <HoldButton
            class="note-panel-foot-hold"
            label={t().palm.rowToCodex}
            hint={t().palm.holdPromote}
            icon="book"
            onConfirm={() => props.onPromote()}
          />
        }
      >
        <button
          type="button"
          class="note-panel-foot-action note-panel-foot-action--commit"
          onClick={() => props.onCommit()}
        >
          <Icon name="book-bookmark" size={15} />
          {t().codex.commit}
          <Show when={props.commitDelta}>
            {(delta) => <span class="note-panel-delta">{delta()}</span>}
          </Show>
        </button>
      </Show>
      <HoldButton
        class="note-panel-foot-hold"
        label={t().common.delete}
        hint={t().palm.holdDelete}
        icon="trash"
        danger
        onConfirm={() => props.onDelete()}
      />
    </div>
  );

  return (
    <aside
      class="note-panel"
      classList={{
        "note-panel--open": props.open,
        "note-panel--screen": props.screen,
      }}
      aria-label={label()}
      aria-hidden={!props.open}
    >
      <Show
        when={props.screen}
        fallback={
          <div
            class="note-panel-head"
            classList={{ "note-panel-head--tabs": props.kind === "codex" }}
          >
            <Show
              when={props.kind === "codex"}
              fallback={<span class="list-pane-title">{label()}</span>}
            >
              {tabs()}
            </Show>
          </div>
        }
      >
        {/* No back arrow of its own: the round back button at the foot already peels this
            sheet (Workspace's backToList), and two arrows on one screen read as two different
            ways out */}
        <div class="note-panel-screen-head">
          <span class="note-panel-screen-title">{props.title || t().notes.untitled}</span>
        </div>
        {props.summary}
        <Show when={props.kind === "codex"}>{tabs()}</Show>
      </Show>

      <div class="note-panel-body">
        <Show when={props.tab === "history"} fallback={settings()}>
          {props.history}
        </Show>
      </div>

      <Show when={props.tab === "note"}>{props.screen ? footActions() : actions()}</Show>

      <Show when={!props.screen && props.tab === "history"}>
        <div class="note-panel-foot">{t().codex.historyFoot}</div>
      </Show>
    </aside>
  );
}
