import { createMemo, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import TagText from "./TagText";
import type { NoteItem, TimelineItem } from "../lib/items";
import { createLongPress } from "../lib/long-press";
import { entryMeta } from "../lib/timeline-meta";
import { places } from "../lib/places";
import { t } from "../lib/i18n";

interface OriginChipProps {
  note: NoteItem;
  onOpen: (note: NoteItem) => void;
  onUnlink: (note: NoteItem) => void;
}

/**
 * 昇格ノートへの入り口。開くのがタップ、繋がりを解くのが隠しアクション。
 * 通常は各エントリの真下に出るが、元のエントリが消えたノートの避難先として
 * Timeline が日見出しの直下にも並べる。
 */
export function OriginChip(props: OriginChipProps): JSX.Element {
  // モバイルの解除は長押し。PC はホバーで出る × が受ける
  const press = createLongPress(() => props.onUnlink(props.note));

  return (
    <span class="origin-chip">
      <button
        type="button"
        class="origin-chip-open long-press"
        onClick={() => {
          // 長押しで解除した直後の click で開かない
          if (press.shouldClick()) {
            props.onOpen(props.note);
          }
        }}
        onPointerDown={(e) => press.onPointerDown(e)}
        onPointerUp={() => press.onPointerUp()}
        onPointerMove={() => press.onPointerMove()}
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
        title={t().timeline.unlink(props.note.title)}
        aria-label={t().timeline.unlink(props.note.title)}
        onClick={() => props.onUnlink(props.note)}
      >
        <Icon name="x" size={12} />
      </button>
    </span>
  );
}

interface TimelineEntryProps {
  item: TimelineItem;
  /** このエントリから育ったノート。チップとして本文の真下に出す。 */
  notes: NoteItem[];
  selecting: boolean;
  selected: boolean;
  onToggle: () => void;
  onPromote: () => void;
  onOpenNote: (note: NoteItem) => void;
  onUnlinkNote: (note: NoteItem) => void;
}

export default function TimelineEntry(props: TimelineEntryProps): JSX.Element {
  const meta = createMemo(() => entryMeta(props.item.context, places.nameOf));
  // モバイルの入り口は長押し。タップには何も割り当てない
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
          {/* 選択モード中だけ本文がクリックできる。押すと選択のトグル */}
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
          {/* 記録は書き換えない。本文は読むだけで、触れる先はノートへの昇格だけ */}
          <p
            class="entry-text long-press"
            onPointerDown={(e) => press.onPointerDown(e)}
            onPointerUp={() => press.onPointerUp()}
            onPointerMove={() => press.onPointerMove()}
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

          {/* このエントリから育ったノート。origin の日時で引くので
              日単位ではなく元の記録の真下に付く */}
          <Show when={props.notes.length}>
            <div class="entry-notes">
              <For each={props.notes}>
                {(note) => (
                  <OriginChip note={note} onOpen={props.onOpenNote} onUnlink={props.onUnlinkNote} />
                )}
              </For>
            </div>
          </Show>

          {/* PC の入り口。隠しアクションの流儀どおり、ホバーでだけ現れる */}
          <div class="entry-actions">
            <button
              type="button"
              class="icon-button entry-action"
              title={t().timeline.promote}
              aria-label={t().timeline.promote}
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
