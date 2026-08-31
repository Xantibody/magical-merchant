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
  resolveBody,
  resolveLine,
  splitVariables,
  TEMPLATE_VARS,
} from "../lib/template-vars";
import "../styles/templates.css";

const UNDO_MS = 5000;

/** 変数チップの挿し先。テンプレで `{{…}}` を書ける欄はこの 3 つ。 */
type VarField = "title" | "body" | "tag";

/** 編集中の 1 枚。ディスクの姿と見比べて「未保存」を出すのに使う。 */
interface Draft {
  title: string;
  body: string;
  tags: string[];
}

const EMPTY_DRAFT: Draft = { title: "", body: "", tags: [] };

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
  /** 最後にディスクから読んだ / ディスクへ書いた姿。 */
  const [baseline, setBaseline] = createSignal<Draft>(EMPTY_DRAFT);
  /** 削除の猶予中だけ一覧から伏せる。 */
  const [hidden, setHidden] = createSignal<string[]>([]);

  let bodyRef: HTMLTextAreaElement | undefined;
  let titleRef: HTMLInputElement | undefined;
  let tagRef: HTMLInputElement | undefined;
  let nameRef: HTMLInputElement | undefined;
  let highlightRef: HTMLPreElement | undefined;

  /** 最後に触っていた欄。開いた直後に押されたら本文に入れる。 */
  const [varField, setVarField] = createSignal<VarField>("body");

  const fieldInput = (field: VarField): HTMLInputElement | HTMLTextAreaElement | undefined => {
    if (field === "title") {
      return titleRef;
    }
    if (field === "tag") {
      return tagRef;
    }
    return bodyRef;
  };

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

  /**
   * 元に戻したばかりの書きかけ。ディスクの読み込みで潰さないための目印で、
   * 立っているのは復元の batch のあいだだけ。
   */
  let restoring: Draft | undefined;

  /** ディスクから来た姿を写す。ここが「未保存かどうか」の基準になる。 */
  const load = (draft: Draft): void => {
    batch(() => {
      setTitle(draft.title);
      setBody(draft.body);
      setTags(draft.tags);
      setBaseline(draft);
      setSaveStatus("idle");
    });
  };

  const current = (): Draft => ({ title: title(), body: body(), tags: tags() });

  // 選んだテンプレの中身を読む。新規作成中は読まない — 空の枠に
  // 前に選んでいたテンプレの本文が流れ込む
  createEffect(() => {
    const file = selectedFile();
    if (!file || draftName() !== null || restoring) {
      return;
    }
    void (async () => {
      try {
        const detail = await typedInvoke("read_template", { filename: file });
        if (selectedFile() !== file) {
          return;
        }
        const titled = splitTitle(detail.body);
        load({ title: titled.title, body: titled.body, tags: detail.tags });
      } catch {
        if (selectedFile() === file) {
          load(EMPTY_DRAFT);
        }
      }
    })();
  });

  /** ディスクの姿と食い違っているか。保存ボタンが押せるかはこれで決まる。 */
  const dirty = createMemo<boolean>(() => {
    const base = baseline();
    return (
      title() !== base.title ||
      body() !== base.body ||
      tags().length !== base.tags.length ||
      tags().some((tag, at) => tag !== base.tags[at])
    );
  });

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

  /**
   * 保存するものがあるか。新規は名前さえ決まっていれば書ける — 中身が空の
   * ひな型にも意味がある。既存は変えたときだけ。
   */
  const canSave = (): boolean =>
    targetFilename() !== undefined &&
    saveStatus() !== "saving" &&
    (draftName() !== null || dirty());

  /**
   * 明示的に保存する。テンプレは書きかけのまま置かれると、そこから作る
   * ノートまで壊れる。打つたびに書き出す作りにはしない。
   */
  const save = (): void => {
    const filename = targetFilename();
    if (!filename || !canSave()) {
      return;
    }
    const draft = current();
    setSaveStatus("saving");

    void (async () => {
      try {
        await typedInvoke("save_template", {
          filename,
          body: joinTitle(draft.title, draft.body),
          tags: draft.tags,
        });
        batch(() => {
          setBaseline(draft);
          setSaveStatus("saved");
        });
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
  };

  // ⌘S / Ctrl+S。保存ボタンしか入口がないと、書きながら残せない
  const onKeyDown = (e: KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    }
  };
  globalThis.addEventListener("keydown", onKeyDown);
  onCleanup(() => globalThis.removeEventListener("keydown", onKeyDown));

  /** 書きかけを抱えたまま編集を離れる。捨てたことは伝えて、戻す道も残す。 */
  const leaveEditor = (next: () => void): void => {
    if (!dirty()) {
      next();
      return;
    }
    const undo = { file: selectedFile(), name: draftName(), draft: current() };
    shell.showToast(t().templates.discarded, () => {
      restoring = undo.draft;
      batch(() => {
        setSelectedFile(undo.file);
        setDraftName(undo.name);
        setTitle(undo.draft.title);
        setBody(undo.draft.body);
        setTags(undo.draft.tags);
        setDetailOpen(true);
      });
      // 読み込みの effect は batch の終わりに走り終えている
      restoring = undefined;
    });
    next();
  };

  const startNew = (): void => {
    leaveEditor(() => {
      batch(() => {
        setSelectedFile(null);
        setDraftName("");
        setTagInput("");
        setDetailOpen(true);
        load(EMPTY_DRAFT);
      });
      // 名前が決まるまでは保存できない。最初に要るものへ先に連れていく
      queueMicrotask(() => nameRef?.focus());
    });
  };

  const select = (template: Template): void => {
    leaveEditor(() => {
      batch(() => {
        setDraftName(null);
        setSelectedFile(template.filename);
        setDetailOpen(true);
      });
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
    setTags((tagList) => addTemplateTag(tagList, tagInput()));
    setTagInput("");
  };

  /**
   * カーソルの居る場所に変数を差し込む。挿し先は最後に触っていた欄 —
   * 常に本文だと、タイトルやタグに変数を置く手段がなくなる。押したあとも
   * その欄に戻す。
   */
  const insertVariable = (token: string): void => {
    const field = varField();
    const el = fieldInput(field);
    if (!el) {
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const next = `${el.value.slice(0, start)}${token}${el.value.slice(end)}`;

    if (field === "title") {
      setTitle(next);
    } else if (field === "tag") {
      setTagInput(next);
    } else {
      setBody(next);
    }

    const caret = start + token.length;
    queueMicrotask(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  /** 「今日作るとこうなる」。変数の書き方が合っているかはここで分かる。 */
  const preview = createMemo<{ title: string; tags: string[]; body: string }>(() => {
    const now = new Date();
    return {
      title: resolveLine(title(), now, locale()),
      tags: tags()
        .map((tag) => resolveLine(tag, now, locale()))
        .filter((tag) => tag.trim() !== ""),
      body: resolveBody(body(), now, locale()),
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
              onClick={() => leaveEditor(() => setDetailOpen(false))}
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
                    ref={nameRef}
                    placeholder={t().templates.namePlaceholder}
                    aria-label={t().templates.namePlaceholder}
                    value={draftName() ?? ""}
                    onInput={(e) => setDraftName(e.currentTarget.value)}
                  />
                }
              >
                {/* 名前はノートの frontmatter に刻まれる値。あとから変えると
                    そのテンプレから育ったノートとの繋がりが切れるので出すだけ */}
                <span class="detail-created">{selected()?.name}</span>
              </Show>
              {/* 未保存のあいだは、保存の手応えより先にそのことを出す */}
              <Show
                when={dirty()}
                fallback={
                  <Show when={saveStatus() !== "idle"}>
                    <span class="detail-save-status">
                      {saveStatus() === "saving" ? t().common.saving : t().common.saved}
                    </span>
                  </Show>
                }
              >
                <span class="detail-save-status templates-unsaved">{t().templates.unsaved}</span>
              </Show>
            </span>

            <div class="detail-actions">
              <button
                type="button"
                class="button-primary templates-save"
                disabled={!canSave()}
                onClick={save}
              >
                {t().common.save}
              </button>
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
            ref={titleRef}
            placeholder={t().templates.titlePlaceholder}
            aria-label={t().templates.titlePlaceholder}
            value={title()}
            onFocus={() => setVarField("title")}
            onInput={(e) => setTitle(e.currentTarget.value)}
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
                    onClick={() => setTags((tagList) => tagList.filter((kept) => kept !== tag))}
                  >
                    <Icon name="x" size={10} />
                  </button>
                </span>
              )}
            </For>
            <input
              type="text"
              class="templates-tag-input"
              ref={tagRef}
              placeholder={t().templates.addTag}
              aria-label={t().templates.addTag}
              value={tagInput()}
              onFocus={() => setVarField("tag")}
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
              onFocus={() => setVarField("body")}
              onInput={(e) => setBody(e.currentTarget.value)}
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
            {/* 見出しは置かない。チップが `{{date}} 日付` と自分で名乗るので、
                読めば分かるものに 1 行ぶんの高さを使わない */}
            <div class="templates-vars" role="group" aria-label={t().templates.insertVariable}>
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
            {/* 畳んだ 1 行で「今日作るとこうなる」のタイトルまでは常に見える。
                本文まで確かめたいときだけ開く — 開きっぱなしにすると、
                書く場所より読む場所のほうが広い画面になる */}
            <details class="templates-preview">
              <summary class="templates-preview-summary">
                {t().templates.todayPreview} — {preview().title || t().templates.untitled}
              </summary>
              <div class="templates-preview-body">
                <Show when={preview().tags.length > 0}>
                  <p class="templates-preview-tags">
                    <For each={preview().tags}>
                      {(tag) => <span class="tag-badge">#{tag}</span>}
                    </For>
                  </p>
                </Show>
                {/* 解けずに残った変数は本文の層と同じ印で示す。ここに出るのは
                    綴りを間違えたものか、作るときにしか決まらない {{prev}} */}
                <pre class="templates-preview-text">
                  <For each={splitVariables(preview().body)}>
                    {(run) => <span classList={{ "templates-var": run.variable }}>{run.text}</span>}
                  </For>
                </pre>
              </div>
            </details>
          </div>
        </Show>
      </div>
    </div>
  );
}
