import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import { typedInvoke } from "../lib/commands";
import { t } from "../lib/i18n";
import { isImeComposing } from "../lib/ime";
import {
  addTag,
  contextRows,
  formatRecordedAt,
  resolveEditedTime,
  toDatetimeLocal,
} from "../lib/note-meta";

interface NoteMetaPopoverProps {
  filename: string;
  /** Show the revert row only while this device still holds the body from before the edit. */
  revertable?: boolean;
  onRevert?: () => void;
  /** Make the list reload after a save. Changing time moves the date group too. */
  onSaved: () => Promise<void>;
  onClose: () => void;
}

/**
 * A small panel that shows a note's frontmatter.
 *
 * Only time and tags can be edited. updated (the time it was rewritten) and context (which
 * device it was written on) are records, so they are laid out read-only. The filename is
 * the ID that sync and the widgets point at, and it is not shown here either.
 */
export default function NoteMetaPopover(props: NoteMetaPopoverProps): JSX.Element {
  const [meta] = createResource(
    () => props.filename,
    (filename) => typedInvoke("read_note_meta", { filename }),
  );

  const [timeValue, setTimeValue] = createSignal("");
  const [tags, setTags] = createSignal<string[]>([]);
  const [tagInput, setTagInput] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [failed, setFailed] = createSignal(false);

  // The record written in the file at the moment of opening becomes the initial edit value
  createEffect(() => {
    const m = meta();
    if (m) {
      setTimeValue(toDatetimeLocal(m.time));
      setTags(m.tags);
    }
  });

  const commitTagInput = (): void => {
    setTags((current) => addTag(current, tagInput()));
    setTagInput("");
  };

  const save = async (): Promise<void> => {
    const m = meta();
    if (!m || saving()) {
      return;
    }
    // A half-typed tag left in the input counts as meant to be saved too
    commitTagInput();
    setSaving(true);
    setFailed(false);
    try {
      await typedInvoke("update_note_meta", {
        filename: props.filename,
        time: resolveEditedTime(m.time, timeValue()),
        tags: tags(),
      });
      await props.onSaved();
      props.onClose();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="popover note-meta-popover">
      <Show when={!meta.error} fallback={<p class="note-meta-error">{t().meta.unreadable}</p>}>
        <Show when={meta()}>
          {(m) => (
            <>
              <label class="note-meta-field">
                <span class="note-meta-label">{t().meta.createdAt}</span>
                <input
                  type="datetime-local"
                  class="note-meta-input"
                  value={timeValue()}
                  onInput={(e) => setTimeValue(e.currentTarget.value)}
                />
              </label>

              {/* The created time can be edited, but the updated time is the record of when
                  it was rewritten. A record that can be moved by hand is no record, so it
                  is shown read-only */}
              <Show when={m().updated}>
                {(updated) => (
                  <div class="note-meta-field">
                    <span class="note-meta-label">{t().meta.updatedAt}</span>
                    <span class="note-meta-readonly">{formatRecordedAt(updated())}</span>
                  </div>
                )}
              </Show>

              <div class="note-meta-field">
                <span class="note-meta-label">{t().common.tags}</span>
                <div class="note-meta-tags">
                  <For each={tags()}>
                    {(tag) => (
                      <span class="tag-badge">
                        #{tag}
                        <button
                          type="button"
                          class="note-meta-tag-remove"
                          aria-label={t().meta.removeTag(tag)}
                          onClick={() =>
                            setTags((current) => current.filter((kept) => kept !== tag))
                          }
                        >
                          <Icon name="x" size={10} />
                        </button>
                      </span>
                    )}
                  </For>
                </div>
                <input
                  type="text"
                  class="note-meta-input"
                  placeholder={t().meta.addTag}
                  value={tagInput()}
                  onInput={(e) => setTagInput(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    // The Enter that commits a conversion belongs to the IME. It does not
                    // commit a tag (#102)
                    if (e.key === "Enter" && !isImeComposing(e)) {
                      e.preventDefault();
                      commitTagInput();
                    }
                  }}
                />
                <span class="note-meta-hint">{t().meta.tagsHint}</span>
              </div>

              <Show when={contextRows(m().context, m().source).length > 0}>
                <div class="note-meta-field">
                  <span class="note-meta-label">{t().meta.context}</span>
                  <div class="note-meta-context">
                    <For each={contextRows(m().context, m().source)}>
                      {(row) => (
                        <>
                          <span class="note-meta-context-label">{row.label}</span>
                          <span>{row.value}</span>
                        </>
                      )}
                    </For>
                  </div>
                </div>
              </Show>

              <Show when={props.revertable}>
                <div class="note-meta-field">
                  <span class="note-meta-label">{t().meta.backup}</span>
                  <button
                    type="button"
                    class="button-secondary note-meta-revert"
                    onClick={() => props.onRevert?.()}
                  >
                    <Icon name="clock-counter-clockwise" size={14} />
                    {t().meta.revert}
                  </button>
                  <span class="note-meta-hint">{t().meta.revertHint}</span>
                </div>
              </Show>

              <div class="note-meta-actions">
                <Show when={failed()}>
                  <span class="note-meta-error">{t().meta.saveFailed}</span>
                </Show>
                <button
                  type="button"
                  class="button-primary note-meta-save"
                  disabled={saving()}
                  onClick={() => {
                    void save();
                  }}
                >
                  {t().common.save}
                </button>
              </div>
            </>
          )}
        </Show>
      </Show>
    </div>
  );
}
