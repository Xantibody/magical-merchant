import {
  batch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import Icon from "../components/Icon";
import { typedInvoke } from "../lib/commands";
import type { Template } from "../lib/commands";
import { useShell } from "../lib/shell";
import { locale, t } from "../lib/i18n";
import { isImeComposing } from "../lib/ime";
import { createKeyboardTop, keyboardTopStyle } from "../lib/keyboard";
import { joinTitle, splitTitle } from "../lib/note-title";
import { ROUTES } from "../lib/routes";
import {
  addTemplateTag,
  hasVariable,
  resolveLine,
  splitVariables,
  TEMPLATE_VARS,
} from "../lib/template-vars";
import "../styles/templates.css";

const SAVE_DEBOUNCE_MS = 1000;
const UNDO_MS = 5000;

/**
 * ファイル名にできない文字を落とす。テンプレ名はそのままファイル名になる。
 *
 * ここは打ち間違いを直すためのもので、守りの最後ではない。区切り文字も
 * `..` も NUL も、受け取った core の `NoteFilename` が改めて弾く。
 */
function toFileStem(raw: string): string {
  return raw.trim().replaceAll(/[/\\:*?"<>|]/g, "");
}

/**
 * テンプレートの管理画面。
 *
 * 作りは Workspace と同じ 2 ペインで、書くものが「ノート」から
 * 「ノートのひな型」に変わるだけ。編集にエディタ(Milkdown)を使わないのは、
 * ここで見たいのが本文の見た目ではなく `{{…}}` がどこにあるかだから。
 */
export default function Templates(): JSX.Element {
  const shell = useShell();
  const navigate = useNavigate();

  const [templates, { refetch }] = createResource(() => typedInvoke("list_templates"));
  const [selectedFile, setSelectedFile] = createSignal<string | null>(null);
  const [detailOpen, setDetailOpen] = createSignal(false);
  /** 新規作成中だけ名前の下書きが入る。既存を編集しているあいだは null。 */
  const [draftName, setDraftName] = createSignal<string | null>(null);
  const [title, setTitle] = createSignal("");
  const [body, setBody] = createSignal("");
  const [tags, setTags] = createSignal<string[]>([]);
  const [tagInput, setTagInput] = createSignal("");
  const [saveStatus, setSaveStatus] = createSignal<"idle" | "saving" | "saved">("idle");
  /** 削除の猶予中だけ一覧から伏せる。 */
  const [hidden, setHidden] = createSignal<string[]>([]);

  let bodyRef: HTMLTextAreaElement | undefined;
  let highlightRef: HTMLPreElement | undefined;

  // 変数の挿入列は画面の下端にある。触る端末ではキーボードがちょうどそこを
  // 覆うので、開いているあいだだけその上へ逃がす
  const keyboardTop = createKeyboardTop();

  const visible = createMemo<Template[]>(() => {
    const dropped = new Set(hidden());
    return (templates() ?? []).filter((template) => !dropped.has(template.filename));
  });

  const selected = createMemo<Template | undefined>(() =>
    visible().find((template) => template.filename === selectedFile()),
  );

  /** 新規作成中に打たれた名前が、既にあるテンプレとぶつかっていないか。 */
  const nameTaken = createMemo<boolean>(() => {
    const draft = toFileStem(draftName() ?? "");
    return draft !== "" && visible().some((template) => template.name === draft);
  });

  const editing = (): boolean => selected() !== undefined || draftName() !== null;

  // 選んだテンプレの中身を読む。新規作成中は読まない — 空の枠に
  // 前に選んでいたテンプレの本文が流れ込む
  createEffect(() => {
    const file = selectedFile();
    if (!file || draftName() !== null) {
      return;
    }
    void (async () => {
      try {
        const detail = await typedInvoke("read_template", { filename: file });
        if (selectedFile() !== file) {
          return;
        }
        const titled = splitTitle(detail.body);
        batch(() => {
          setTitle(titled.title);
          setBody(titled.body);
          setTags(detail.tags);
          setSaveStatus("idle");
        });
      } catch {
        if (selectedFile() === file) {
          batch(() => {
            setTitle("");
            setBody("");
            setTags([]);
          });
        }
      }
    })();
  });

  // ---- 保存（1 秒 debounce + 直列化）----
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saveChain: Promise<void> = Promise.resolve();

  /** いま書いているものの保存先。名前が決まっていなければ保存しない。 */
  const targetFilename = (): string | undefined => {
    const draft = draftName();
    if (draft !== null) {
      const stem = toFileStem(draft);
      // 名前が空、または既にある名前。どちらも上書き事故になる
      return stem === "" || nameTaken() ? undefined : `${stem}.md`;
    }
    return selected()?.filename;
  };

  const flushSave = (): Promise<void> => {
    const filename = targetFilename();
    const content = joinTitle(title(), body());
    const currentTags = tags();
    const previous = saveChain;

    saveChain = (async () => {
      await previous;
      if (!filename) {
        return;
      }
      setSaveStatus("saving");
      try {
        await typedInvoke("save_template", { filename, body: content, tags: currentTags });
        setSaveStatus("saved");
        await refetch();
        // 名前が決まった時点で、新規作成から「そのテンプレの編集」に変わる
        if (draftName() !== null) {
          batch(() => {
            setDraftName(null);
            setSelectedFile(filename);
          });
        }
      } catch {
        setSaveStatus("idle");
        shell.showToast(t().templates.saveFailed);
      }
    })();
    return saveChain;
  };

  const scheduleSave = (): void => {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => void flushSave(), SAVE_DEBOUNCE_MS);
  };

  onCleanup(() => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      void flushSave();
    }
  });

  const startNew = (): void => {
    batch(() => {
      setSelectedFile(null);
      setDraftName("");
      setTitle("");
      setBody("");
      setTags([]);
      setTagInput("");
      setSaveStatus("idle");
      setDetailOpen(true);
    });
  };

  const select = (template: Template): void => {
    batch(() => {
      setDraftName(null);
      setSelectedFile(template.filename);
      setDetailOpen(true);
    });
  };

  const remove = (template: Template): void => {
    batch(() => {
      setHidden((files) => [...files, template.filename]);
      setSelectedFile(null);
      setDetailOpen(false);
    });

    const commit = setTimeout(() => {
      void (async () => {
        await typedInvoke("delete_template", { filename: template.filename });
        await refetch();
        setHidden((files) => files.filter((file) => file !== template.filename));
      })();
    }, UNDO_MS);

    shell.showToast(t().templates.deleted, () => {
      clearTimeout(commit);
      setHidden((files) => files.filter((file) => file !== template.filename));
    });
  };

  const commitTagInput = (): void => {
    setTags((current) => addTemplateTag(current, tagInput()));
    setTagInput("");
    scheduleSave();
  };

  /** カーソルの居る場所に変数を差し込む。押したあとも本文に戻れるように。 */
  const insertVariable = (token: string): void => {
    const el = bodyRef;
    if (!el) {
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = `${body().slice(0, start)}${token}${body().slice(end)}`;
    setBody(next);
    scheduleSave();
    queueMicrotask(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  /** 「今日作るとこうなる」。変数の書き方が合っているかはここで分かる。 */
  const preview = createMemo<{ title: string; tags: string[] }>(() => {
    const now = new Date();
    return {
      title: resolveLine(title(), now, locale()),
      tags: tags()
        .map((tag) => resolveLine(tag, now, locale()))
        .filter((tag) => tag.trim() !== ""),
    };
  });

  return (
    <div class="workspace templates" classList={{ "workspace--detail": detailOpen() }}>
      <div class="list-pane">
        <div class="list-pane-head">
          <button
            type="button"
            class="icon-button templates-back"
            aria-label={t().templates.backToSettings}
            onClick={() => navigate(ROUTES.SETTINGS)}
          >
            <Icon name="arrow-left" size={16} />
          </button>
          <span class="list-pane-title">TEMPLATES</span>
          <button type="button" class="new-note" onClick={startNew}>
            <Icon name="plus" size={12} />
            {t().templates.new}
          </button>
        </div>

        <div class="list-scroll">
          <Show
            when={visible().length > 0}
            fallback={
              <div class="notes-empty">
                <Icon name="file-text" size={24} />
                <p class="notes-empty-title">{t().templates.empty}</p>
                <p class="notes-empty-body">{t().templates.emptyHint}</p>
              </div>
            }
          >
            <For each={visible()}>
              {(template) => (
                <button
                  type="button"
                  class="list-row"
                  classList={{ "list-row--selected": selected()?.filename === template.filename }}
                  onClick={() => select(template)}
                >
                  <span class="list-row-title">{template.name}</span>
                  <span class="list-row-meta">
                    {template.preview}
                    {/* 一覧では変数を解かない。定義そのものを見る場所なので、
                        `{{date}}` が今日の日付に化けていると区別がつかない */}
                    <For each={template.tags}>
                      {(tag) => (
                        <span class="tag-badge" classList={{ "tag-badge--var": hasVariable(tag) }}>
                          #{tag}
                        </span>
                      )}
                    </For>
                  </span>
                </button>
              )}
            </For>
          </Show>
        </div>

        <p class="templates-file-hint">{t().templates.fileHint}</p>
      </div>

      <div class="detail-pane">
        <Show
          when={editing()}
          fallback={<div class="detail-empty">{t().templates.noSelection}</div>}
        >
          <div class="detail-meta-bar">
            <button
              type="button"
              class="icon-button detail-back"
              aria-label={t().templates.backToList}
              onClick={() => {
                void flushSave();
                setDetailOpen(false);
              }}
            >
              <Icon name="arrow-left" size={18} />
            </button>
            <span class="detail-meta">
              <Show
                when={draftName() === null}
                fallback={
                  <input
                    type="text"
                    class="templates-name-input"
                    placeholder={t().templates.namePlaceholder}
                    aria-label={t().templates.namePlaceholder}
                    value={draftName() ?? ""}
                    onInput={(e) => {
                      setDraftName(e.currentTarget.value);
                      scheduleSave();
                    }}
                  />
                }
              >
                {/* 名前はノートの frontmatter に刻まれる値。あとから変えると
                    そのテンプレから育ったノートとの繋がりが切れるので出すだけ */}
                <span class="detail-created">{selected()?.name}</span>
              </Show>
              <Show when={saveStatus() !== "idle"}>
                <span class="detail-save-status">
                  {saveStatus() === "saving" ? t().common.saving : t().common.saved}
                </span>
              </Show>
            </span>

            <div class="detail-actions">
              <Show when={selected()}>
                {(template) => (
                  <button
                    type="button"
                    class="icon-button"
                    title={t().common.delete}
                    aria-label={t().common.delete}
                    onClick={() => remove(template())}
                  >
                    <Icon name="trash" size={17} />
                  </button>
                )}
              </Show>
            </div>
          </div>

          <Show when={nameTaken()}>
            <p class="templates-name-error">{t().templates.nameTaken}</p>
          </Show>

          <input
            type="text"
            class="note-title-input"
            placeholder={t().templates.titlePlaceholder}
            aria-label={t().templates.titlePlaceholder}
            value={title()}
            onInput={(e) => {
              setTitle(e.currentTarget.value);
              scheduleSave();
            }}
          />

          <div class="templates-tags">
            <span class="templates-tags-label">{t().templates.autoTags}</span>
            <For each={tags()}>
              {(tag) => (
                <span class="tag-badge" classList={{ "tag-badge--var": hasVariable(tag) }}>
                  #{tag}
                  <button
                    type="button"
                    class="note-meta-tag-remove"
                    aria-label={t().templates.removeTag(tag)}
                    onClick={() => {
                      setTags((current) => current.filter((kept) => kept !== tag));
                      scheduleSave();
                    }}
                  >
                    <Icon name="x" size={10} />
                  </button>
                </span>
              )}
            </For>
            <input
              type="text"
              class="templates-tag-input"
              placeholder={t().templates.addTag}
              aria-label={t().templates.addTag}
              value={tagInput()}
              onInput={(e) => setTagInput(e.currentTarget.value)}
              onBlur={commitTagInput}
              onKeyDown={(e) => {
                // 変換確定の Enter は IME のもの (#102)
                if (e.key === "Enter" && !isImeComposing(e)) {
                  e.preventDefault();
                  commitTagInput();
                }
              }}
            />
          </div>

          {/* 本文。書かれたままの文字は textarea が持ち、`{{…}}` の色は
              真下に敷いた同じ文字の層が描く。textarea 自体は部分的に
              色を変えられないので、重ねる以外に見せる手がない */}
          <div class="templates-body">
            <pre class="templates-body-highlight" aria-hidden="true" ref={highlightRef}>
              <For each={splitVariables(body())}>
                {(run) => <span classList={{ "templates-var": run.variable }}>{run.text}</span>}
              </For>
              {"\n"}
            </pre>
            <textarea
              class="templates-body-input"
              ref={bodyRef}
              placeholder={t().templates.bodyPlaceholder}
              aria-label={t().templates.bodyPlaceholder}
              spellcheck={false}
              value={body()}
              onInput={(e) => {
                setBody(e.currentTarget.value);
                scheduleSave();
              }}
              onScroll={(e) => {
                if (highlightRef) {
                  highlightRef.scrollTop = e.currentTarget.scrollTop;
                  highlightRef.scrollLeft = e.currentTarget.scrollLeft;
                }
              }}
            />
          </div>

          <div
            class="templates-footer"
            classList={{ "templates-footer--floating": keyboardTop() !== undefined }}
            style={keyboardTopStyle(keyboardTop())}
          >
            <div class="templates-vars">
              <span class="templates-tags-label">{t().templates.insertVariable}</span>
              <For each={TEMPLATE_VARS}>
                {(variable) => (
                  <button
                    type="button"
                    class="tag-chip templates-var-chip"
                    // textarea から選択位置を奪わない。奪うと挿し込む先を見失う
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insertVariable(variable.token)}
                  >
                    <code>{variable.token}</code>
                    {variable.label()}
                  </button>
                )}
              </For>
            </div>
            <p class="templates-preview">
              {t().templates.todayPreview} — {preview().title || t().templates.untitled}
              <For each={preview().tags}>{(tag) => <span class="tag-badge">#{tag}</span>}</For>
            </p>
          </div>
        </Show>
      </div>
    </div>
  );
}
