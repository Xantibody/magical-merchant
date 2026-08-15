import {
  createSignal,
  createResource,
  createMemo,
  createEffect,
  on,
  batch,
  For,
  Show,
  lazy,
  onCleanup,
} from "solid-js";
import type { JSX } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import type { Editor } from "@milkdown/kit/core";
import Icon from "../components/Icon";
import MarkdownPreview from "../components/MarkdownPreview";
import NoteMetaPopover from "../components/NoteMetaPopover";
import { typedInvoke } from "../lib/commands";
import { getDeviceSignals } from "../lib/client-context";
import { useShell } from "../lib/shell";
import { groupNotes, itemTitle, noteCreatedLabel, toNoteItems } from "../lib/items";
import type { ItemGroup, NoteItem } from "../lib/items";
import { readNoteContent, toggledView, viewToFrontmatter } from "../lib/note-view";
import type { NoteView } from "../lib/note-view";
import {
  beginEditSession,
  readBackup,
  recordSaved,
  shouldSave,
  writeBackup,
} from "../lib/edit-backup";
import type { CaretPoint } from "../components/MilkdownEditor";

// Milkdown + ProseMirror は編集を始めるまで要らない。一覧とプレビューだけの
// 表示をこの重さから切り離す
const MilkdownEditor = lazy(() => import("../components/MilkdownEditor"));
const MarkdownToolbar = lazy(() => import("../components/MarkdownToolbar"));
// markmap-view は d3 を連れてくる。マインドマップにしたノートを開くまで読まない
const MindmapView = lazy(() => import("../components/MindmapView"));

const UNDO_MS = 5000;
const SAVE_DEBOUNCE_MS = 1000;

async function loadNotes(): Promise<NoteItem[]> {
  return toNoteItems(await typedInvoke("list_notes"));
}

/** 一覧の 2 段目に出す更新日。「08/04」 */
function noteDate(item: NoteItem): string {
  return item.date ? item.date.slice(5).replace("-", "/") : "";
}

function EmptyNotes(): JSX.Element {
  return (
    <div class="notes-empty">
      <Icon name="note-pencil" size={24} />
      <p class="notes-empty-title">ノートがありません</p>
      <p class="notes-empty-body">新規から始めると、ここに並びます。</p>
    </div>
  );
}

export default function Workspace(): JSX.Element {
  const shell = useShell();
  const [searchParams, setSearchParams] = useSearchParams();
  const today = new Date();

  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [detailOpen, setDetailOpen] = createSignal(false);
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [saveStatus, setSaveStatus] = createSignal<"idle" | "saving" | "saved">("idle");
  const [hidden, setHidden] = createSignal<string[]>([]);
  const [noteBody, setNoteBody] = createSignal("");
  const [noteView, setNoteView] = createSignal<NoteView>("editor");
  /** 本文の読み込みが済んでいるノートの id。`?edit=1` の自動編集開始が待つ。 */
  const [loadedId, setLoadedId] = createSignal<string | null>(null);
  /** タッチ端末のツールバーが叩く先。編集をやめると undefined に戻る。 */
  const [markdownEditor, setMarkdownEditor] = createSignal<Editor | undefined>();

  const [notes, { refetch: refetchNotes }] = createResource(loadNotes);

  let detailBodyRef: HTMLDivElement | undefined;
  /** プレビューで押された場所。エディタのマウント時に一度だけ読まれる。 */
  const [tapCaret, setTapCaret] = createSignal<CaretPoint | undefined>();
  /** いま開いている編集セッション。保存のスキップ判断とバックアップを持つ。 */
  let session = beginEditSession("");

  // 同期やパレット操作の後にデータを取り直す。初回は createResource が読むので
  // defer しないと全ノートの読み直しがマウント直後に二重で走る
  createEffect(on(shell.dataVersion, () => void refetchNotes(), { defer: true }));

  const visibleItems = createMemo<NoteItem[]>(() => {
    const dropped = new Set(hidden());
    return (notes() ?? []).filter((item) => !dropped.has(item.id));
  });

  const groups = createMemo<ItemGroup[]>(() => groupNotes(visibleItems(), today));

  const selected = createMemo<NoteItem | undefined>(() => {
    const items = visibleItems();
    return items.find((item) => item.id === selectedId()) ?? items[0];
  });

  // ウィジェットの行から `?file=` 付きで来たときだけ、その 1 件を開く。
  // 一覧が届く前に来ることがあるが、id はファイル名そのものなので先に置ける
  createEffect(
    on(
      () => searchParams.file,
      (file) => {
        if (typeof file === "string" && file) {
          setSelectedId(file);
          setDetailOpen(true);
        }
      },
    ),
  );

  // ---- 選択中ノートの本文と表示モードを読む ----
  createEffect(() => {
    const item = selected();
    if (!item) {
      setNoteBody("");
      setNoteView("editor");
      return;
    }
    void (async () => {
      try {
        const content = await readNoteContent(
          () => typedInvoke("read_note", { filename: item.filename }),
          () => typedInvoke("read_note_meta", { filename: item.filename }),
        );
        // 一覧を素早くたどると、遅い読みが速い読みを追い越して届く。
        // いま選ばれているノートへの答えだけを画面に出す
        if (selected()?.id !== item.id) {
          return;
        }
        // 本文とモードは対で出す。バラすと一瞬だけ違うモードで描かれる
        batch(() => {
          setNoteBody(content.body);
          setNoteView(content.view);
          setLoadedId(item.id);
        });
      } catch {
        // 読めないノートを選んだまま、前のノートの本文を出し続けない
        if (selected()?.id === item.id) {
          batch(() => {
            setNoteBody("");
            setNoteView("editor");
            setLoadedId(item.id);
          });
        }
      }
    })();
  });

  const toggleNoteView = async (item: NoteItem): Promise<void> => {
    const next = toggledView(noteView());
    // 保存を待たずに切り替える。書き込みは frontmatter が壊れたノートで
    // 失敗し得るので、そのときは表示だけ戻す
    setNoteView(next);
    try {
      await typedInvoke("set_note_view", {
        filename: item.filename,
        view: viewToFrontmatter(next),
      });
    } catch {
      setNoteView(toggledView(next));
    }
  };

  const select = (item: NoteItem): void => {
    shell.closePopovers();
    setSelectedId(item.id);
    setEditing(false);
    setDetailOpen(true);
  };

  // ---- 編集（自動保存: 1秒 debounce + 直列化）----
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saveChain: Promise<void> = Promise.resolve();

  const flushSave = (): Promise<void> => {
    const item = selected();
    const body = draft();
    const current = session;
    const previous = saveChain;
    saveChain = (async () => {
      await previous;
      // 触っていない誤タップのセッションを書き込みに変えない。書いても
      // 内容が変わらないなら、ファイルの mtime を動かして同期を起こすだけ
      if (!item || !shouldSave(current, body)) {
        return;
      }
      setSaveStatus("saving");
      try {
        await typedInvoke("update_draft", {
          filePath: item.path,
          body,
          client: await getDeviceSignals(),
        });
        recordSaved(localStorage, item.filename, current, body);
        // 一覧はここでは読み直さない。1 秒おきの保存のたびに全ノートを
        // 読み直すのは低スペック端末に重く、編集中は一覧が見えてもいない。
        // 編集を終えるときに 1 回だけ読み直す。
        setSaveStatus("saved");
      } catch {
        setSaveStatus("idle");
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

  const startEditing = (point?: CaretPoint): void => {
    if (!selected()) {
      return;
    }
    session = beginEditSession(noteBody());
    setTapCaret(point);
    setDraft(noteBody());
    setSaveStatus("idle");
    setEditing(true);
  };

  /** プレビューのどこを押しても、その場所から書き始められる。 */
  const onPreviewClick = (e: MouseEvent): void => {
    if (editing() || noteView() !== "editor" || !selected()) {
      return;
    }
    const target = e.target instanceof Element ? e.target : null;
    // リンクは踏める・図はズームのまま。編集に化けさせない
    if (target?.closest("a, button, .mermaid-block, .mermaid-zoom")) {
      return;
    }
    // 本文をなぞってコピーしたいだけのときも編集へ切り替えない
    const selection = document.getSelection();
    if (selection && !selection.isCollapsed) {
      return;
    }
    startEditing({ x: e.clientX, y: e.clientY, scrollTop: detailBodyRef?.scrollTop ?? 0 });
  };

  /**
   * この端末に残した「編集前の本文」と今の本文を入れ替える。入れ替えなので
   * もう一度押せば戻せる — 戻る先は常にちょうど 1 段。
   */
  const revertEdit = async (item: NoteItem): Promise<void> => {
    const backup = readBackup(localStorage, item.filename);
    const current = noteBody();
    if (backup === null || backup === current) {
      return;
    }
    try {
      await typedInvoke("update_draft", {
        filePath: item.path,
        body: backup,
        client: await getDeviceSignals(),
      });
    } catch {
      shell.showToast("戻せませんでした");
      return;
    }
    writeBackup(localStorage, item.filename, current);
    setNoteBody(backup);
    shell.closePopovers();
    await refetchNotes();
    shell.showToast("編集前の内容に戻しました");
  };

  // タイムラインからの昇格 (?edit=1) は、本文が届き次第そのまま書き始める。
  // パラメータは消費したら消す — 再読み込みのたびに編集へ放り込まない
  createEffect(() => {
    if (searchParams.edit !== "1") {
      return;
    }
    const item = selected();
    if (!item || item.filename !== searchParams.file || loadedId() !== item.id) {
      return;
    }
    startEditing();
    setSearchParams({ edit: undefined }, { replace: true });
  });

  const revertable = createMemo<boolean>(() => {
    const item = selected();
    // 編集中に戻すと、開いているエディタが次の自動保存で復元を上書きする
    if (!item || editing()) {
      return false;
    }
    const backup = readBackup(localStorage, item.filename);
    return backup !== null && backup !== noteBody();
  });

  const stopEditing = async (): Promise<void> => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    await flushSave();
    // 書き終えた本文が真実。読み直しを待ってからプレビューを出すと
    // 一瞬だけ編集前の本文が見える
    setNoteBody(draft());
    setEditing(false);
    await refetchNotes();
  };

  const createNote = async (): Promise<void> => {
    await typedInvoke("create_draft", { body: "", tags: [], client: await getDeviceSignals() });
    await refetchNotes();
    setDetailOpen(true);
  };

  // ---- 削除 + Undo（5秒は tombstone、経過後に本削除）----
  const remove = (item: NoteItem): void => {
    setHidden((ids) => [...ids, item.id]);
    setEditing(false);

    const commit = setTimeout(() => {
      void (async () => {
        await typedInvoke("delete_note", { filename: item.filename });
        await refetchNotes();
        setHidden((ids) => ids.filter((id) => id !== item.id));
      })();
    }, UNDO_MS);

    shell.showToast("ノートを削除しました", () => {
      clearTimeout(commit);
      setHidden((ids) => ids.filter((id) => id !== item.id));
    });
  };

  return (
    <div class="workspace" classList={{ "workspace--detail": detailOpen() }}>
      <div class="list-pane">
        <div class="list-pane-head">
          <span class="list-pane-title">NOTES</span>
          <button type="button" class="new-note" onClick={() => void createNote()}>
            <Icon name="plus" size={12} />
            新規
          </button>
        </div>

        <div class="list-scroll">
          <Show when={groups().length} fallback={<EmptyNotes />}>
            <For each={groups()}>
              {(group) => (
                <>
                  <div class="list-group-label">{group.label}</div>
                  <For each={group.items}>
                    {(item) => (
                      <button
                        type="button"
                        class="list-row"
                        classList={{ "list-row--selected": selected()?.id === item.id }}
                        onClick={() => select(item as NoteItem)}
                      >
                        <span class="list-row-title">{itemTitle(item)}</span>
                        <span class="list-row-meta">
                          {noteDate(item as NoteItem)}
                          <For each={(item as NoteItem).tags}>
                            {(tag) => <span class="tag-badge">#{tag}</span>}
                          </For>
                        </span>
                      </button>
                    )}
                  </For>
                </>
              )}
            </For>
          </Show>
        </div>
      </div>

      <div class="detail-pane">
        <Show when={selected()} fallback={<div class="detail-empty">項目がありません</div>}>
          {(item) => (
            <>
              <div class="detail-meta-bar">
                <button
                  type="button"
                  class="icon-button detail-back"
                  aria-label="一覧に戻る"
                  onClick={() => {
                    // 編集したまま戻ると、一覧の上にツールバーだけが残る。
                    // 見えなくなった編集対象に効くボタンが浮いていることになる。
                    void stopEditing();
                    setDetailOpen(false);
                  }}
                >
                  <Icon name="arrow-left" size={18} />
                </button>
                <span class="detail-meta">
                  {/* ファイル名は同期やウィジェットが指す ID であって人に見せる
                      ものではない。人が読むのは作成日時 */}
                  <span class="detail-created">{noteCreatedLabel(item())}</span>
                  <Show when={editing() && saveStatus() !== "idle"}>
                    <span class="detail-save-status">
                      {saveStatus() === "saving" ? "保存中…" : "保存しました"}
                    </span>
                  </Show>
                </span>

                <div class="detail-actions">
                  <Show when={!editing()}>
                    <button
                      type="button"
                      class="icon-button"
                      title={noteView() === "mindmap" ? "エディタで表示" : "マインドマップで表示"}
                      aria-label={
                        noteView() === "mindmap" ? "エディタで表示" : "マインドマップで表示"
                      }
                      aria-pressed={noteView() === "mindmap"}
                      onClick={() => void toggleNoteView(item())}
                    >
                      <Icon
                        name={noteView() === "mindmap" ? "file-text" : "tree-structure"}
                        size={17}
                      />
                    </button>
                  </Show>
                  <button
                    type="button"
                    class="icon-button detail-meta-button"
                    title="ノート情報"
                    aria-label="ノート情報"
                    aria-expanded={shell.popover() === "note-meta"}
                    onClick={() => shell.togglePopover("note-meta")}
                  >
                    <Icon name="info" size={17} />
                  </button>
                  {/* 編集の入り口は本文タップ。鉛筆は出口だけ残す */}
                  <Show when={editing()}>
                    <button
                      type="button"
                      class="icon-button"
                      title="編集を終える"
                      aria-label="編集を終える"
                      onClick={() => void stopEditing()}
                    >
                      <Icon name="check" size={17} />
                    </button>
                  </Show>
                  <button
                    type="button"
                    class="icon-button"
                    title="削除"
                    aria-label="削除"
                    onClick={() => remove(item())}
                  >
                    <Icon name="trash" size={17} />
                  </button>
                </div>
              </div>

              <Show when={shell.popover() === "note-meta"}>
                <NoteMetaPopover
                  filename={item().filename}
                  revertable={revertable()}
                  onRevert={() => void revertEdit(item())}
                  onSaved={async () => {
                    await refetchNotes();
                  }}
                  onClose={() => shell.closePopovers()}
                />
              </Show>

              {/* biome-ignore/eslint 対応: タップは編集開始の補助経路で、
                  同じ操作はキーボードでは編集終了ボタンと Tab 移動で賄える */}
              <div
                class="detail-body"
                ref={detailBodyRef}
                role="presentation"
                onClick={onPreviewClick}
              >
                <Show
                  when={editing()}
                  fallback={
                    <Show
                      when={noteView() === "mindmap"}
                      fallback={<MarkdownPreview source={noteBody()} />}
                    >
                      <MindmapView source={noteBody()} />
                    </Show>
                  }
                >
                  <MilkdownEditor
                    placeholder="ノートを書く…"
                    caret={tapCaret()}
                    defaultValue={draft()}
                    onChange={(markdown) => {
                      setDraft(markdown);
                      scheduleSave();
                    }}
                    onEditorReady={setMarkdownEditor}
                  />
                </Show>
              </div>
            </>
          )}
        </Show>
      </div>

      {/* キーボードでは打ちにくい記法のための入り口。タッチ端末にだけ出る。
          lazy なので、無条件に描くと一覧を見ただけでエディタ一式を読み込んで
          しまう。エディタが立ち上がってから初めて描く */}
      <Show when={markdownEditor()}>{(editor) => <MarkdownToolbar editor={editor()} />}</Show>
    </div>
  );
}
