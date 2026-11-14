import { createMemo, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import HoldButton from "./HoldButton";
import Icon from "./Icon";
import TagText from "./TagText";
import { closeSwipedRows, createArmed } from "../lib/palm-gestures";
import type { NoteItem, ScrawlItem } from "../lib/items";
import { createLongPress } from "../lib/long-press";
import { briefMeta, entryMeta } from "../lib/scrawl-meta";
import type { MetaSegment } from "../lib/scrawl-meta";
import { places } from "../lib/places";
import { t } from "../lib/i18n";

interface OriginChipProps {
  note: NoteItem;
  onOpen: (note: NoteItem) => void;
  onUnlink: (note: NoteItem) => void;
}

/**
 * The way into a promoted note. A tap opens it; unlinking is the hidden action.
 * It normally appears directly under its entry, but Scrawl also lines these up under the day
 * heading as the place a note goes when its originating entry is gone.
 */
function OriginChip(props: OriginChipProps): JSX.Element {
  // On mobile, a long press unlinks. On desktop the close button shown on hover takes it
  const press = createLongPress(() => props.onUnlink(props.note));

  return (
    <span class="origin-chip">
      <button
        type="button"
        class="origin-chip-open long-press"
        onClick={() => {
          // The click that follows a long-press unlink must not open it
          if (press.shouldClick()) {
            props.onOpen(props.note);
          }
        }}
        onPointerDown={(e) => press.onPointerDown(e)}
        onPointerUp={() => press.onPointerUp()}
        onPointerMove={(e) => press.onPointerMove(e)}
        onPointerCancel={() => press.onPointerCancel()}
        onContextMenu={(e) => press.onContextMenu(e)}
      >
        <Icon name="file-text" size={13} />
        <span class="origin-chip-title">{props.note.title}</span>
        <span class="origin-chip-arrow" aria-hidden="true">
          →
        </span>
      </button>
      <button
        type="button"
        class="origin-chip-unlink"
        title={t().scrawl.unlink(props.note.title)}
        aria-label={t().scrawl.unlink(props.note.title)}
        onClick={() => props.onUnlink(props.note)}
      >
        <Icon name="x" size={12} />
      </button>
    </span>
  );
}

interface ScrawlEntryProps {
  item: ScrawlItem;
  /** Notes grown from this entry. They appear as chips directly under the body. */
  notes: NoteItem[];
  /** Just left from the input line. Its dot shows green for a moment. */
  fresh?: boolean;
  selecting: boolean;
  selected: boolean;
  /** Opened by a tap: the full meta and the action row show. One record at a time (Scrawl). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onToggle: () => void;
  onPromote: () => void;
  onCopy: () => void;
  /** Deletes this record once a press has been held (96); resolves once the list has been reread. */
  onDelete: () => Promise<void>;
  /** Just sent from the field: for a few seconds it can be taken back (36). */
  onTakeBack?: () => void;
  onOpenNote: (note: NoteItem) => void;
  onUnlinkNote: (note: NoteItem) => void;
}

function MetaParts(props: { segments: MetaSegment[] }): JSX.Element {
  return (
    <For each={props.segments}>
      {(segment) => (
        <span class="entry-meta-part">
          <Icon name={segment.icon} size={12} />
          {segment.label}
        </span>
      )}
    </For>
  );
}

/**
 * Two meta rows that say the same thing. A place lookup swaps the whole table of names, so
 * most entries recompute their row and get an equal one back in new objects; `<For>` would
 * rebuild each of its parts and icons for a name that belongs to another record.
 */
function sameMeta(a: MetaSegment[], b: MetaSegment[]): boolean {
  return (
    a.length === b.length &&
    a.every((segment, i) => segment.icon === b[i]?.icon && segment.label === b[i]?.label)
  );
}

export default function ScrawlEntry(props: ScrawlEntryProps): JSX.Element {
  const meta = createMemo(() => entryMeta(props.item.context, places.nameOf), undefined, {
    equals: sameMeta,
  });
  const brief = createMemo(() => briefMeta(props.item.context, places.nameOf), undefined, {
    equals: sameMeta,
  });
  /** Everything recorded, in words: the brief line's tooltip on a wide window. */
  const metaTitle = (): string =>
    meta()
      .map((segment) => segment.label)
      .join(" · ");
  // A held finger still promotes, as before; a tap opens the record's actions
  const press = createLongPress(() => props.onPromote());

  /**
   * A tap opens or closes the record. A long press has its own click to swallow, and a mouse
   * drag that selected some of the text is a copy in progress, not a tap.
   */
  const tap = (): void => {
    if (!press.shouldClick()) {
      return;
    }
    if (globalThis.getSelection()?.isCollapsed === false) {
      return;
    }
    props.onOpenChange(!props.open);
  };

  /**
   * The hover trash opens the record onto its row, where delete is a held press like every
   * other delete (96): a click alone never takes a record away.
   */
  const askDelete = (): void => {
    props.onOpenChange(true);
  };

  /** Whether a stroke has picked this row: only then is anything behind it (palm-gestures.ts). */
  const [armed, armRef] = createArmed();

  /** What sits behind the row for a stroke to the left (25): grow it, or let it go (held). */
  const behind = (): JSX.Element => (
    // Hidden from the keys and the reader: the record's own row of actions (a tap) holds the same
    <div class="swipe-actions" data-swipe-actions aria-hidden="true">
      <button
        type="button"
        class="swipe-action"
        tabIndex={-1}
        onClick={() => {
          closeSwipedRows();
          props.onPromote();
        }}
      >
        <Icon name="note-pencil" size={17} />
        {t().palm.rowToNote}
      </button>
      <HoldButton
        label={t().common.delete}
        hint={t().palm.holdShort}
        icon="trash"
        danger
        tabIndex={-1}
        onConfirm={() => {
          closeSwipedRows();
          void props.onDelete();
        }}
      />
    </div>
  );

  return (
    <article class="swipe-row" data-swipe={props.selecting ? undefined : ""} ref={armRef}>
      {/* Mounted for the one row a stroke has picked, not for every line of every day */}
      <Show when={!props.selecting && armed()}>{behind()}</Show>
      <div
        class="entry swipe-face"
        data-entry={props.item.id}
        classList={{
          "entry--fresh": props.fresh === true,
          "entry--selected": props.selected,
          "entry--promoted": props.notes.length > 0,
        }}
      >
        <span class="entry-time">{props.item.time.slice(0, 5)}</span>
        <span class="entry-rail" aria-hidden="true">
          <span class="entry-rail-line" />
          <span class="entry-rail-dot" />
        </span>

        <div class="entry-body">
          <Show when={props.selecting}>
            {/* The body is clickable only in select mode. A press toggles the selection */}
            <button
              type="button"
              class="entry-select"
              aria-pressed={props.selected}
              onClick={() => props.onToggle()}
            >
              <Icon name={props.selected ? "check-circle" : "circle"} size={16} />
              <span class="entry-select-text">
                <TagText text={props.item.text} />
              </span>
            </button>
          </Show>

          <Show when={!props.selecting}>
            {/* A record is never rewritten. The body is only read; a tap opens what it leads to
              (copy, a Note, delete) and a held finger still promotes. Making the body a button
              would make something to read look like something to press, so the keyboard
              reaches the same actions through the toolbar below instead */}
            {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events */}
            <p
              class="entry-text long-press"
              onClick={tap}
              onPointerDown={(e) => press.onPointerDown(e)}
              onPointerUp={() => press.onPointerUp()}
              onPointerMove={(e) => press.onPointerMove(e)}
              onPointerCancel={() => press.onPointerCancel()}
              onContextMenu={(e) => press.onContextMenu(e)}
            >
              <TagText text={props.item.text} />
            </p>
            {/* One quiet line that never wraps; the whole of it waits for the record to open */}
            <Show when={!props.open && (brief().length > 0 || props.onTakeBack)}>
              <div class="entry-meta" title={metaTitle()}>
                {/* The line just sent says how to take it back, on itself, for a few seconds */}
                <Show when={props.onTakeBack}>
                  <button
                    type="button"
                    class="entry-take-back"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onTakeBack?.();
                    }}
                  >
                    <Icon name="arrow-counter-clockwise" size={12} />
                    {t().palm.takeBack}
                  </button>
                </Show>
                <MetaParts segments={brief()} />
              </div>
            </Show>
            <Show when={props.open && meta().length > 0}>
              <div class="entry-meta entry-meta--full">
                <MetaParts segments={meta()} />
              </div>
            </Show>

            {/* Notes grown from this entry. They are looked up by the origin timestamp, so
              they attach directly under the original record rather than per day */}
            <Show when={props.notes.length}>
              <div class="entry-notes">
                <For each={props.notes}>
                  {(note) => (
                    <OriginChip
                      note={note}
                      onOpen={props.onOpenNote}
                      onUnlink={props.onUnlinkNote}
                    />
                  )}
                </For>
              </div>
            </Show>

            {/* A record is read, never rewritten: copy, grow it into a Note, or let it go */}
            <Show when={props.open}>
              <div class="entry-open" role="toolbar" aria-label={t().scrawl.actions}>
                <button type="button" class="entry-open-action" onClick={() => props.onCopy()}>
                  <Icon name="copy" size={15} />
                  {t().scrawl.copy}
                </button>
                <button type="button" class="entry-open-action" onClick={() => props.onPromote()}>
                  <Icon name="note-pencil" size={15} />
                  {t().scrawl.promote}
                </button>
                {/* Held, not asked: the question and its answer are the same press (96) */}
                <HoldButton
                  class="entry-open-action"
                  label={t().common.delete}
                  hint={t().palm.holdDelete}
                  icon="trash"
                  danger
                  onConfirm={() => {
                    void props.onDelete();
                  }}
                />
              </div>
            </Show>

            {/* The same actions on a wide window, shown on hover and on keyboard focus, so a
              mouse does not have to open the record first. A phone has the tap instead */}
            <Show when={!props.open}>
              <div class="entry-actions">
                <button
                  type="button"
                  class="icon-button entry-action"
                  title={t().scrawl.copy}
                  aria-label={t().scrawl.copy}
                  onClick={() => props.onCopy()}
                >
                  <Icon name="copy" size={15} />
                </button>
                <button
                  type="button"
                  class="icon-button entry-action"
                  title={t().scrawl.promote}
                  aria-label={t().scrawl.promote}
                  onClick={() => props.onPromote()}
                >
                  <Icon name="note-pencil" size={15} />
                </button>
                <button
                  type="button"
                  class="icon-button entry-action"
                  title={t().common.delete}
                  aria-label={t().common.delete}
                  onClick={askDelete}
                >
                  <Icon name="trash" size={15} />
                </button>
              </div>
            </Show>
          </Show>
        </div>
      </div>
    </article>
  );
}
