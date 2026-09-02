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
  /** この端末に「編集前の本文」が残っているときだけ復元の行を出す。 */
  revertable?: boolean;
  onRevert?: () => void;
  /** 保存後に一覧を読み直させる。time を変えると日付グループも動く。 */
  onSaved: () => Promise<void>;
  onClose: () => void;
}

/**
 * ノートの frontmatter を見せる小さなパネル。
 *
 * 編集できるのは time と tags だけ。updated(書き直した時刻)と context
 * (どの端末で書いたか)は記録なので読み取り専用で並べる。ファイル名は
 * 同期とウィジェットが指す ID であり、ここにも出さない。
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

  // 開いた時点でファイルに書いてある記録を編集の初期値にする
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
    // 入力欄に打ちかけのタグが残っていたら、それも保存の意思とみなす
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

              {/* 作成日時は編集できるが、更新日時は「いつ書き直したか」の記録。
                  手で動かせては記録にならないので読み取り専用で出す */}
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
                    // 変換確定の Enter は IME のもの。タグ確定には使わない (#102)
                    if (e.key === "Enter" && !isImeComposing(e)) {
                      e.preventDefault();
                      commitTagInput();
                    }
                  }}
                />
                <span class="note-meta-hint">{t().meta.tagsHint}</span>
              </div>

              <Show when={contextRows(m().context).length > 0}>
                <div class="note-meta-field">
                  <span class="note-meta-label">{t().meta.context}</span>
                  <div class="note-meta-context">
                    <For each={contextRows(m().context)}>
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
