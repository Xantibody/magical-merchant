import { createSignal, Show } from "solid-js";
import type { JSX } from "solid-js";
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
   * Whether it is the phone's own screen, swapped in for the body. Otherwise it is the 320px
   * panel at the right edge, floating (hover) or docked (pinned).
   */
  screen?: boolean;
  /** The note's title. Only the phone's screen shows it, in its header. */
  title: string;
  /** Whether the panel is on screen. The screen is on screen whenever it is mounted. */
  open: boolean;
  pinned: boolean;
  tab: NotePanelTab;
  /** The version count beside the history tab. */
  historyCount: number;
  onTab: (tab: NotePanelTab) => void;
  /** The phone's back arrow. */
  onBack?: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;

  readOnly: boolean;
  mapOpen: boolean;
  /** Whether the note has template examples. The switch is not shown for one that has none. */
  hasExamples: boolean;
  examplesShown: boolean;
  onToggleReadOnly: () => void;
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
   * The phone's tag section. The desktop edits tags on the meta line instead. A function, so
   * the editor is built once where it is placed rather than on every read of the prop.
   */
  tags?: () => JSX.Element;

  canRevert: boolean;
  /** Why revert cannot be pressed. Absent when there is nothing worth saying. */
  revertHint?: string;
  onRevert: () => void;
  /** Note only. Opens the confirmation; nothing moves yet. */
  onPromote: () => void;
  /** Codex only. */
  onCommit: () => void;
  onDelete: () => void;
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
 * On a wide window it is 320px at the right edge. Resting the pointer on the edge floats it
 * over the body; the toggle in the title row and ⌘. dock it beside the body. A Codex adds the
 * history as a second tab of the same slot, and the history never opens on hover: 320px of
 * comparison must not appear in passing beside a writing hand. On a phone it is a screen of
 * its own that swaps with the body, the way the history screen used to.
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
      <div class="note-panel-section">{t().notes.view}</div>
      <SwitchRow
        icon="lock-simple"
        size={iconSize()}
        label={t().notes.readOnly}
        checked={props.readOnly}
        onToggle={props.onToggleReadOnly}
      />
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
      <p class="note-panel-hint">{t().notes.viewExclusive}</p>

      <Show when={props.tags}>
        {(render) => (
          <>
            <div class="note-panel-section">{t().common.tags}</div>
            <div class="note-panel-tags">{render()()}</div>
          </>
        )}
      </Show>

      <button
        type="button"
        class="note-panel-section note-panel-disclosure"
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
        <Show when={!props.screen}>
          <span class="note-panel-key" aria-hidden="true">
            {shortcutLabel("noteRevert")}
          </span>
        </Show>
      </button>
      <Show when={!props.canRevert && props.revertHint}>
        {(hint) => <p class="note-panel-hint note-panel-action-hint">{hint()}</p>}
      </Show>
      <Show when={props.kind === "note"}>
        <button
          type="button"
          class="note-panel-row note-panel-action"
          onClick={() => props.onPromote()}
        >
          <Icon name="book" size={iconSize()} />
          <span class="note-panel-row-label">
            {t().codex.promote}
            <span class="note-panel-row-sub">{t().codex.promoteSub}</span>
          </span>
        </button>
      </Show>
      <Show when={props.kind === "codex"}>
        <button
          type="button"
          class="note-panel-row note-panel-action"
          onClick={() => props.onCommit()}
        >
          <Icon name="book-bookmark" size={iconSize()} />
          <span class="note-panel-row-label">{t().codex.commit}</span>
          <Show when={!props.screen}>
            <span class="note-panel-key" aria-hidden="true">
              {shortcutLabel("codexCommit")}
            </span>
          </Show>
        </button>
      </Show>
      <hr class="note-panel-divider" />
      <button
        type="button"
        class="note-panel-row note-panel-action note-panel-action--danger"
        onClick={() => props.onDelete()}
      >
        <Icon name="trash" size={iconSize()} />
        <span class="note-panel-row-label">{t().common.delete}</span>
      </button>
    </div>
  );

  return (
    <aside
      class="note-panel"
      classList={{
        "note-panel--open": props.open,
        "note-panel--pinned": props.pinned,
        "note-panel--screen": props.screen,
      }}
      aria-label={label()}
      aria-hidden={!props.open}
      onPointerEnter={() => props.onPointerEnter?.()}
      onPointerLeave={() => props.onPointerLeave?.()}
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
        <div class="note-panel-screen-head">
          <button
            type="button"
            class="icon-button note-panel-back"
            aria-label={t().codex.backToBody}
            onClick={() => props.onBack?.()}
          >
            <Icon name="arrow-left" size={18} />
          </button>
          <span class="note-panel-screen-title">{props.title || t().notes.untitled}</span>
        </div>
        <Show when={props.kind === "codex"}>{tabs()}</Show>
      </Show>

      <div class="note-panel-body">
        <Show when={props.tab === "history"} fallback={settings()}>
          {props.history}
        </Show>
      </div>

      <Show when={props.tab === "note"}>{actions()}</Show>

      {/* The rule for opening and closing is written inside the thing that is open. A phone
          swaps the whole screen, and its back arrow says the rest */}
      <Show when={!props.screen}>
        <div class="note-panel-foot">
          <Show when={props.tab === "note"} fallback={t().codex.historyFoot}>
            {props.pinned
              ? t().notes.panelFootPinned(shortcutLabel("noteActions"))
              : t().notes.panelFootHover(shortcutLabel("noteActions"))}
          </Show>
        </div>
      </Show>
    </aside>
  );
}
