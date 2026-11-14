import { createMemo, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import HoldButton from "./HoldButton";
import Icon from "./Icon";
import Popover from "./Popover";
import { createRingPress } from "./Ring";
import type { DropTarget } from "./Ring";
import TemplatePicker from "./TemplatePicker";
import { closeSwipedRows, createArmed } from "../lib/palm-gestures";
import type { NoteKind, Template } from "../lib/commands";
import { fromTheFoot } from "../lib/foot";
import { t } from "../lib/i18n";
import { itemTitle, noteRowStamp, stepNote } from "../lib/items";
import { ringChoices } from "../lib/ring";
import type { ItemGroup, NoteItem } from "../lib/items";
import { MODE_LABELS, ROUTES } from "../lib/routes";
import { useShell } from "../lib/shell";
import { shortcutLabel } from "../lib/shortcuts";

/**
 * The keys that move to the neighbouring row, and their direction through `items` (newest
 * first). The list is drawn from its foot, so the row above is the older one.
 */
const LIST_STEP_KEYS: Readonly<Record<string, 1 | -1>> = { ArrowUp: 1, ArrowDown: -1 };

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
  /** An empty note of the other kind: the template sheet offers both. */
  onCreateKind: (kind: NoteKind) => void;
  /** Behind a row (25): open it to write, grow a Note into a Codex (held), or delete it (held). */
  onWriteRow: (item: NoteItem) => void;
  onPromoteRow: (item: NoteItem) => void;
  onDeleteRow: (item: NoteItem) => void;
  /** The + carried onto a row and let go (7): that note, open to write on a new last line. */
  onAppendRow: (item: NoteItem) => void;
  /** Where the + lands off the rows, on a wide window's open page (Workspace). */
  pageTargetAt?: (x: number, y: number) => DropTarget | null;
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

/** What the + says: it blooms the ring, and carried it adds to a note. */
function plusLabel(): string {
  return `${t().reach.ring} · ${t().reach.dragPlus}`;
}

/**
 * The list of Note and Codex: the middle pane of three on a wide window, a page of its own on a
 * phone. Built from the foot (lib/foot.ts): the newest row stands nearest the thumb, the list's
 * name, its count and its search under it, then the + that blooms the ring. Which popover is open
 * is the app's, so it reads that from the shell; what a press does to the selection is the
 * surface's, so it hands that back.
 */
export default function NoteList(props: NoteListProps): JSX.Element {
  const shell = useShell();

  let listScrollRef: HTMLDivElement | undefined;
  /** The + that opened the ring: the template sheet hangs from it, and a press on it is not outside. */
  let menuTrigger: HTMLButtonElement | undefined;

  /** The groups turned so the newest is at the foot, each group's label over its own rows. */
  const footGroups = createMemo(() => fromTheFoot(props.groups));

  /** The surface's own name: the list's foot says it large, a wide window's foot small. */
  const name = (): string => MODE_LABELS[props.kind === "codex" ? ROUTES.CODEX : ROUTES.NOTES];

  /**
   * Where a carried + lands (7): on a row, that note opens to write on a new line at its end. A
   * wide window's page takes it too (Workspace hands that over), at the spot it is let go.
   */
  const rowTarget = (x: number, y: number): DropTarget | null => {
    const row = document.elementFromPoint(x, y)?.closest<HTMLElement>(".list-row[data-id]");
    const item = row ? props.items.find((one) => one.id === row.dataset.id) : undefined;
    if (!row || !item) {
      return props.pageTargetAt?.(x, y) ?? null;
    }
    const box = row.getBoundingClientRect();
    return {
      label: t().reach.dropOnNote(item.title),
      box: { left: box.left, top: box.top, width: box.width, height: box.height },
      drop: () => props.onAppendRow(item),
    };
  };

  /**
   * The + (65, 7): pressed, the ring blooms round it with the same petals as the pill's; slid
   * past them, the + itself is carried into the list and let go on a note to add to it.
   */
  const ring = createRingPress({
    // The same petals as the pill's (lib/ring.ts), but a new note of either kind is made here,
    // in this list, so it opens in place rather than by a move to its route
    choices: () =>
      ringChoices({
        jot: () => shell.setQuickJot(true),
        note: () => (props.kind === "note" ? props.onCreate() : props.onCreateKind("note")),
        codex: () => (props.kind === "codex" ? props.onCreate() : props.onCreateKind("codex")),
        template: () => shell.togglePopover("new-note-menu", menuTrigger),
      }),
    holdMs: 0,
    carry: () => ({ icon: "plus", label: t().reach.dragPlus, targetAt: rowTarget }),
  });

  /**
   * Up and Down inside the list. It is an action inside the list widget, so it is not on the Cmd
   * table (`SHORTCUTS`) and is taken only inside `.list-scroll`: Up and Down pressed outside the
   * body with nothing selected scroll the page, and that is not taken away.
   * The list has no input field, so no `isTypingTarget` check is needed either.
   *
   * The keys follow the rows as drawn: up is older, since the list grows upward from its foot.
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

  /** The + on either width: a wide window's "+ new" at the list's foot, a phone's round one. */
  const plusPress = {
    ...ring.handlers,
    onPointerDown: (e: PointerEvent & { currentTarget: HTMLElement }): void => {
      if (e.currentTarget instanceof HTMLButtonElement) {
        menuTrigger = e.currentTarget;
      }
      ring.handlers.onPointerDown(e);
    },
    onClick: (e: MouseEvent): void => {
      // The press itself opened the ring; the click after it is not a second thing
      if (!ring.shouldClick()) {
        e.preventDefault();
      }
    },
  };

  return (
    <div class="list-pane">
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
            if (props.kind === "note") {
              props.onCreate();
            } else {
              props.onCreateKind("note");
            }
          }}
          onPickCodex={() => {
            shell.closePopovers();
            if (props.kind === "codex") {
              props.onCreate();
            } else {
              props.onCreateKind("codex");
            }
          }}
          onPick={(template) => props.onCreateFromTemplate(template)}
          onManage={() => {
            shell.closePopovers();
            props.onManageTemplates();
          }}
        />
      </Popover>

      {/* The keys are taken by the rows inside (button); this only bundles them. Like
          `.detail-body`, a container that claims no role. It hangs from its foot (data-foot,
          lib/foot.ts) */}
      <div
        class="list-scroll"
        data-foot
        ref={listScrollRef}
        role="presentation"
        onKeyDown={onListKeyDown}
      >
        <div class="list-stack">
          <Show when={props.groups.length} fallback={<EmptyNotes kind={props.kind} />}>
            <For each={footGroups()}>
              {(group) => (
                <>
                  <div class="list-group-label">{group.label}</div>
                  <For each={group.items}>
                    {(item) => {
                      const [armed, armRef] = createArmed();
                      return (
                        <div class="swipe-row list-swipe" data-swipe ref={armRef}>
                          {/* Behind the row (25): write it now, then the two that cannot be
                            taken back, each a held press (96). Mounted only for the row a stroke
                            has picked. Hidden from the keys and the reader: the same actions
                            stand in the note's panel, which both can reach */}
                          <Show when={armed()}>
                            <div class="swipe-actions" data-swipe-actions aria-hidden="true">
                              <button
                                type="button"
                                class="swipe-action"
                                tabIndex={-1}
                                onClick={() => {
                                  closeSwipedRows();
                                  props.onWriteRow(item as NoteItem);
                                }}
                              >
                                <Icon name="pencil" size={15} />
                                {t().viewer.write}
                              </button>
                              <HoldButton
                                label={
                                  props.kind === "note" ? t().palm.rowToCodex : t().common.delete
                                }
                                tabIndex={-1}
                                hint={t().palm.holdShort}
                                icon={props.kind === "note" ? "book" : "trash"}
                                danger={props.kind !== "note"}
                                onConfirm={() => {
                                  closeSwipedRows();
                                  if (props.kind === "note") {
                                    props.onPromoteRow(item as NoteItem);
                                  } else {
                                    props.onDeleteRow(item as NoteItem);
                                  }
                                }}
                              />
                            </div>
                          </Show>
                          <button
                            type="button"
                            class="list-row swipe-face"
                            data-id={item.id}
                            classList={{
                              "list-row--selected": props.selectedId === item.id,
                              "list-row--codex": props.kind === "codex",
                            }}
                            onClick={() => props.onSelect(item as NoteItem)}
                          >
                            <span class="list-row-title">{itemTitle(item)}</span>
                            {/* Only a Codex row puts the version count on a folded-corner page.
                              The first of the differences from Note */}
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
                        </div>
                      );
                    }}
                  </For>
                </>
              )}
            </For>
          </Show>

          {/* A phone's list ends on its own name and its search, under the newest row: the
              page is named where the thumb is, and reading up, both scroll away with the rows.
              A wide window names it in the foot bar below instead */}
          <div class="list-foot">
            <h1 class="list-big-title">
              {name()}
              <span class="list-big-count">{t().reach.count(props.items.length)}</span>
            </h1>
            <button type="button" class="list-search" onClick={() => shell.openSearch()}>
              <Icon name="magnifying-glass" size={15} />
              {t().palm.search}
            </button>
          </div>
        </div>
      </div>

      {/* A wide window's foot of the list sheet: its name and the + the ring blooms from. The
          + is "new" on both widths, so ⌘N's badge stands on it (a Note's only: ⌘N makes a
          Note, and pressing it on the Codex surface would make something else elsewhere) */}
      <div class="list-pane-head list-pane-foot">
        <span class="list-pane-title">{name()}</span>
        <div class="list-pane-actions">
          <button
            type="button"
            class="new-note ring-trigger"
            title={plusLabel()}
            aria-label={t().notes.new}
            aria-haspopup="menu"
            aria-expanded={ring.open()}
            data-hint-key={props.kind === "codex" ? undefined : shortcutLabel("newNote")}
            {...plusPress}
          >
            <Icon name="plus" size={12} />
            {t().notes.new}
          </button>
        </div>
      </div>

      {/* A phone's +, low on the right where the thumb is (R2), opposite the place pill */}
      <button
        type="button"
        class="compose-fab ring-trigger list-plus"
        title={plusLabel()}
        aria-label={t().library.create(name())}
        aria-haspopup="menu"
        aria-expanded={ring.open()}
        data-no-gesture
        {...plusPress}
      >
        <span class="list-plus-mark" classList={{ "list-plus-mark--open": ring.open() }}>
          <Icon name="plus" size={24} />
        </span>
      </button>
      {ring.view()}
    </div>
  );
}
