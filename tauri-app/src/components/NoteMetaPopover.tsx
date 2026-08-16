import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import { typedInvoke } from "../lib/commands";
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
      <Show when={!meta.error} fallback={<p class="note-meta-error">メタデータを読み取れません</p>}>
        <Show when={meta()}>
          {(m) => (
            <>
              <label class="note-meta-field">
                <span class="note-meta-label">作成日時</span>
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
                    <span class="note-meta-label">更新日時</span>
                    <span class="note-meta-readonly">{formatRecordedAt(updated())}</span>
                  </div>
                )}
              </Show>

              <div class="note-meta-field">
                <span class="note-meta-label">タグ</span>
                <div class="note-meta-tags">
                  <For each={tags()}>
                    {(tag) => (
                      <span class="tag-badge">
                        #{tag}
                        <button
                          type="button"
                          class="note-meta-tag-remove"
                          aria-label={`タグ ${tag} を外す`}
                          onClick={() => setTags((current) => current.filter((t) => t !== tag))}
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
                  placeholder="タグを追加"
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
                <span class="note-meta-hint">作成時の記録。本文の #タグ は本文側で編集</span>
              </div>

              <Show when={contextRows(m().context).length > 0}>
                <div class="note-meta-field">
                  <span class="note-meta-label">記録時の環境</span>
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
                  <span class="note-meta-label">この端末のバックアップ</span>
                  <button
                    type="button"
                    class="button-secondary note-meta-revert"
                    onClick={() => props.onRevert?.()}
                  >
                    <Icon name="clock-counter-clockwise" size={14} />
                    編集前に戻す
                  </button>
                  <span class="note-meta-hint">
                    直前の編集で上書きした本文と入れ替える。もう一度押すと戻る
                  </span>
                </div>
              </Show>

              <div class="note-meta-actions">
                <Show when={failed()}>
                  <span class="note-meta-error">保存できませんでした</span>
                </Show>
                <button
                  type="button"
                  class="button-primary note-meta-save"
                  disabled={saving()}
                  onClick={() => void save()}
                >
                  保存
                </button>
              </div>
            </>
          )}
        </Show>
      </Show>
    </div>
  );
}
