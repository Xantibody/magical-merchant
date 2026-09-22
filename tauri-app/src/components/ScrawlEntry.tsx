import { createMemo, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import TagText from "./TagText";
import type { NoteItem, ScrawlItem } from "../lib/items";
import { createLongPress } from "../lib/long-press";
import { entryMeta } from "../lib/scrawl-meta";
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
export function OriginChip(props: OriginChipProps): JSX.Element {
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
  selecting: boolean;
  selected: boolean;
  onToggle: () => void;
  onPromote: () => void;
  onOpenNote: (note: NoteItem) => void;
  onUnlinkNote: (note: NoteItem) => void;
}

export default function ScrawlEntry(props: ScrawlEntryProps): JSX.Element {
  const meta = createMemo(() => entryMeta(props.item.context, places.nameOf));
  // On mobile the way in is a long press. Nothing is assigned to a tap
  const press = createLongPress(() => props.onPromote());

  return (
    <article
      class="entry"
      classList={{
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
          {/* A record is never rewritten. The body is only read, and the one thing it leads
              to is promotion to a note */}
          {/* The long press is a gesture for a finger; making the body a button would make
              something to read look like something to press. The cost is that there is no
              promotion from the keyboard */}
          {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
          <p
            class="entry-text long-press"
            onPointerDown={(e) => press.onPointerDown(e)}
            onPointerUp={() => press.onPointerUp()}
            onPointerMove={(e) => press.onPointerMove(e)}
            onPointerCancel={() => press.onPointerCancel()}
            onContextMenu={(e) => press.onContextMenu(e)}
          >
            <TagText text={props.item.text} />
          </p>
          <Show when={meta().length}>
            <div class="entry-meta">
              <For each={meta()}>
                {(segment) => (
                  <span class="entry-meta-part">
                    <Icon name={segment.icon} size={12} />
                    {segment.label}
                  </span>
                )}
              </For>
            </div>
          </Show>

          {/* Notes grown from this entry. They are looked up by the origin timestamp, so
              they attach directly under the original record rather than per day */}
          <Show when={props.notes.length}>
            <div class="entry-notes">
              <For each={props.notes}>
                {(note) => (
                  <OriginChip note={note} onOpen={props.onOpenNote} onUnlink={props.onUnlinkNote} />
                )}
              </For>
            </div>
          </Show>

          {/* The way in on desktop. In the manner of a hidden action, it appears on hover only */}
          <div class="entry-actions">
            <button
              type="button"
              class="icon-button entry-action"
              title={t().scrawl.promote}
              aria-label={t().scrawl.promote}
              onClick={() => props.onPromote()}
            >
              <Icon name="note-pencil" size={15} />
            </button>
          </div>
        </Show>
      </div>
    </article>
  );
}
