import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import Popover from "./Popover";
import TemplatePicker from "./TemplatePicker";
import type { NoteKind, Template } from "../lib/commands";
import { t } from "../lib/i18n";
import { itemTitle, noteRowStamp, stepNote } from "../lib/items";
import type { ItemGroup, NoteItem } from "../lib/items";
import { createLongPress } from "../lib/long-press";
import { MODE_LABELS, ROUTES } from "../lib/routes";
import { useShell } from "../lib/shell";
import { shortcutLabel } from "../lib/shortcuts";

/** The keys that move to the neighboring row in the list, and their direction. */
const LIST_STEP_KEYS: Readonly<Record<string, 1 | -1>> = { ArrowUp: -1, ArrowDown: 1 };

interface NoteListProps {
  /** Which surface. A Codex row carries its version count; only a Note offers templates. */
  kind: NoteKind;
  groups: ItemGroup[];
  /** The surface's notes in list order. Up and Down step through them. */
  items: NoteItem[];
  /** The note being looked at. Undefined while there is none. */
  selectedId: string | undefined;
  templates: Template[];
  /** The day a row's stamp is measured from: today's notes show the time, older ones the date. */
  today: Date;
  onSelect: (item: NoteItem) => void;
  /**
   * Up or Down moved to the neighboring row. The focus has already moved; the selection follows
   * here, without the press waiting for the save.
   */
  onStep: (id: string) => void;
  /** An empty note on this surface, opened to write. */
  onCreate: () => void;
  onCreateFromTemplate: (template: Template) => void;
  onManageTemplates: () => void;
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

/**
 * The list flyout of Note and Codex: the head with "+ new" and the pin, the template sheet, the
 * rows grouped by day, and the invisible left edge that opens it. Whether it is out (hover, pin)
 * and which popover is open are the app's, so it reads them from the shell; what a press does to
 * the selection is the surface's, so it hands that back.
 */
export default function NoteList(props: NoteListProps): JSX.Element {
  const shell = useShell();

  let listScrollRef: HTMLDivElement | undefined;
  /** The "+ new" button. It opened the template sheet, so a press on it does not count as outside */
  let newNoteButton: HTMLButtonElement | undefined;

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
    const next = stepNote(props.items, props.selectedId, step);
    if (!next) {
      return;
    }
    e.preventDefault();
    const row = listScrollRef?.querySelector<HTMLElement>(`[data-id="${CSS.escape(next)}"]`);
    row?.focus();
    row?.scrollIntoView({ block: "nearest" });
    props.onStep(next);
  };

  /**
   * On a touch device a long press is the entry to templates. A tap still makes an empty note, so
   * "open and write at once" does not cost one more step.
   */
  const newNoteLongPress = createLongPress(() => {
    if (props.kind === "note") {
      shell.togglePopover("new-note-menu", newNoteButton);
    }
  });
  let newNotePointer = "mouse";

  /**
   * Whether to show the flyout. While not one note is open it stays out: folding with nothing to
   * hide (the body) would leave a screen with nothing on it until the pointer finds the edge.
   */
  const flyoutOpen = (): boolean => shell.listOpen() || props.selectedId === undefined;

  const pinLabel = (): string =>
    shell.listPinned()
      ? t().notes.unpinList(shortcutLabel("listPin"))
      : t().notes.pinList(shortcutLabel("listPin"));

  return (
    <>
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
            {MODE_LABELS[props.kind === "codex" ? ROUTES.CODEX : ROUTES.NOTES]}
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
              data-hint-key={props.kind === "codex" ? undefined : shortcutLabel("newNote")}
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
                if (newNotePointer === "mouse" && props.kind === "note") {
                  shell.togglePopover("new-note-menu", newNoteButton);
                } else {
                  props.onCreate();
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
            templates={props.templates}
            onPickEmpty={() => {
              shell.closePopovers();
              props.onCreate();
            }}
            onPick={(template) => props.onCreateFromTemplate(template)}
            onManage={() => {
              shell.closePopovers();
              props.onManageTemplates();
            }}
          />
        </Popover>

        {/* The keys are taken by the rows inside (button); this only bundles them.
            Like `.detail-body`, a container that claims no role */}
        <div class="list-scroll" ref={listScrollRef} role="presentation" onKeyDown={onListKeyDown}>
          <Show when={props.groups.length} fallback={<EmptyNotes kind={props.kind} />}>
            <For each={props.groups}>
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
                          "list-row--selected": props.selectedId === item.id,
                          "list-row--codex": props.kind === "codex",
                        }}
                        onClick={() => props.onSelect(item as NoteItem)}
                      >
                        <span class="list-row-title">{itemTitle(item)}</span>
                        {/* Only a Codex row puts the version count on a folded-corner page. The
                            first of the differences from Note */}
                        <Show when={props.kind === "codex"}>
                          <PageMark
                            count={(item as NoteItem).versionCount ?? 0}
                            dirty={(item as NoteItem).dirty ?? false}
                          />
                        </Show>
                        <span class="list-row-stamp">
                          {noteRowStamp(item as NoteItem, props.today)}
                        </span>
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
    </>
  );
}
