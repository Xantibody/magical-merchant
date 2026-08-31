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
import { useNavigate, useSearchParams } from "@solidjs/router";
import type { Editor } from "@milkdown/kit/core";
import Icon from "../components/Icon";
import MarkdownPreview from "../components/MarkdownPreview";
import NoteMetaPopover from "../components/NoteMetaPopover";
import TemplatePicker from "../components/TemplatePicker";
import { typedInvoke } from "../lib/commands";
import { getDeviceSignals } from "../lib/client-context";
import { useShell } from "../lib/shell";
import { groupNotes, itemTitle, noteCreatedLabel, toNoteItems } from "../lib/items";
import type { ItemGroup, NoteItem } from "../lib/items";
import { readNoteContent, toggledView, viewToFrontmatter } from "../lib/note-view";
import type { NoteView } from "../lib/note-view";
import { joinTitle, splitTitle } from "../lib/note-title";
import { formatMonthDay } from "../lib/day-labels";
import { locale, t } from "../lib/i18n";
import { isImeComposing } from "../lib/ime";
import { createLongPress } from "../lib/long-press";
import {
  beginEditSession,
  readBackup,
  recordSaved,
  shouldSave,
  writeBackup,
} from "../lib/edit-backup";
import type { EditSession } from "../lib/edit-backup";
import type { CaretPoint } from "../components/MilkdownEditor";
import type { NoteLinkTarget } from "../lib/note-link-plugin";
import type { SearchHit, Template } from "../lib/commands";
import { ROUTES } from "../lib/routes";
import "../styles/workspace.css";

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
  return item.date ? formatMonthDay(item.date) : "";
}

function EmptyNotes(): JSX.Element {
  return (
    <div class="notes-empty">
      <Icon name="note-pencil" size={24} />
      <p class="notes-empty-title">{t().notes.empty}</p>
      <p class="notes-empty-body">{t().notes.emptyHint}</p>
    </div>
  );
}

export default function Workspace(): JSX.Element {
  const shell = useShell();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const today = new Date();

  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [detailOpen, setDetailOpen] = createSignal(false);
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [saveStatus, setSaveStatus] = createSignal<"idle" | "saving" | "saved">("idle");
  const [hidden, setHidden] = createSignal<string[]>([]);
  /** 先頭 H1 を切り離した本文。エディタとプレビューが見るのはこちら。 */
  const [noteBody, setNoteBody] = createSignal("");
  /** 本文先頭の H1。タイトル欄が編集し、保存のたびに本文へ書き戻す。 */
  const [noteTitle, setNoteTitle] = createSignal("");
  const [noteView, setNoteView] = createSignal<NoteView>("editor");
  /** 本文の読み込みが済んでいるノートの id。`?edit=1` の自動編集開始が待つ。 */
  const [loadedId, setLoadedId] = createSignal<string | null>(null);
  /** タッチ端末のツールバーが叩く先。編集をやめると undefined に戻る。 */
  const [markdownEditor, setMarkdownEditor] = createSignal<Editor | undefined>();

  const [notes, { refetch: refetchNotes }] = createResource(loadNotes);
  // 「新規」を押すまで開かないが、押した瞬間に読み始めると空のメニューが
  // 一度描かれる。件数は数件で、一覧と一緒に取っても目に見える差は出ない
  const [templates, { refetch: refetchTemplates }] = createResource(() =>
    typedInvoke("list_templates"),
  );

  let detailBodyRef: HTMLDivElement | undefined;
  /** プレビューで押された場所。エディタのマウント時に一度だけ読まれる。 */
  const [tapCaret, setTapCaret] = createSignal<CaretPoint | undefined>();
  /** いま開いている編集セッション。保存のスキップ判断とバックアップを持つ。 */
  let session = beginEditSession("");
  /** そのセッションがどのノートのものか。null なら開いていない。 */
  let sessionFile: string | null = null;

  // 同期やパレット操作の後にデータを取り直す。初回は createResource が読むので
  // defer しないと全ノートの読み直しがマウント直後に二重で走る
  createEffect(
    on(
      shell.dataVersion,
      () => {
        void refetchNotes();
        void refetchTemplates();
      },
      { defer: true },
    ),
  );

  const visibleItems = createMemo<NoteItem[]>(() => {
    const dropped = new Set(hidden());
    return (notes() ?? []).filter((item) => !dropped.has(item.id));
  });

  const groups = createMemo<ItemGroup[]>(() => groupNotes(visibleItems(), today));

  const selected = createMemo<NoteItem | undefined>(() => {
    const items = visibleItems();
    return items.find((item) => item.id === selectedId()) ?? items[0];
  });

  /**
   * ファイルに書く本文。タイトル欄とエディタは別々に見せているが、
   * 保存・バックアップ・マインドマップが扱うのは常に結合した全文。
   */
  const fullBody = (): string => joinTitle(noteTitle(), editing() ? draft() : noteBody());

  /**
   * 書き換える直前の本文でセッションを開く。開いている間は開き直さない —
   * タイトルを直してから本文を触っても、戻る先は「触る前」のまま。
   */
  const ensureSession = (): void => {
    const item = selected();
    if (!item || sessionFile === item.filename) {
      return;
    }
    session = beginEditSession(fullBody());
    sessionFile = item.filename;
  };

  /** `[[ID]]` → タイトルの解決表。プレビューが毎回これを引いて描く。 */
  const noteTitles = createMemo<ReadonlyMap<string, string>>(
    () => new Map(visibleItems().map((item) => [item.filename.replace(/\.md$/, ""), item.title])),
  );

  /** `[[` 補完の候補。自分自身へのリンクは出さない。 */
  const linkTargets = (): NoteLinkTarget[] =>
    visibleItems()
      .filter((item) => item.id !== selected()?.id)
      .map((item) => ({ id: item.filename.replace(/\.md$/, ""), title: item.title }));

  // このノートを [[ID]] で指している記録。開くたびに走査で導出される
  const [backlinks] = createResource(
    () => selected()?.filename,
    (filename) => typedInvoke("find_backlinks", { filename }),
  );

  const openBacklink = (hit: SearchHit): void => {
    if (hit.kind === "note" && hit.filename) {
      setSelectedId(hit.filename);
      setDetailOpen(true);
    } else {
      navigate(`${ROUTES.TIMELINE}?day=${hit.date}`);
    }
  };

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
    // 別のノートに移ったら編集セッションは畳む。戻る先が前のノートの
    // 本文のままだと、次の保存が他人のバックアップを潰す
    sessionFile = null;
    if (!item) {
      batch(() => {
        setNoteBody("");
        setNoteTitle("");
        setNoteView("editor");
      });
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
        const titled = splitTitle(content.body);
        batch(() => {
          setNoteTitle(titled.title);
          setNoteBody(titled.body);
          setNoteView(content.view);
          setLoadedId(item.id);
        });
      } catch {
        // 読めないノートを選んだまま、前のノートの本文を出し続けない
        if (selected()?.id === item.id) {
          batch(() => {
            setNoteTitle("");
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

  /**
   * 保存 1 回ぶんの単位。「どのノートに・何を・どのセッションで」を
   * 呼ばれた時点で固める。タイマーが起きる頃には別のノートが選ばれて
   * いることがあり、そのとき画面の本文を読むと隣のノートへ書いてしまう。
   */
  interface PendingSave {
    item: NoteItem;
    body: string;
    session: EditSession;
  }

  const snapshotSave = (): PendingSave | undefined => {
    const item = selected();
    return item ? { item, body: fullBody(), session } : undefined;
  };

  const flushSave = (pending = snapshotSave()): Promise<void> => {
    const previous = saveChain;
    saveChain = (async () => {
      await previous;
      // 触っていない誤タップのセッションを書き込みに変えない。書いても
      // 内容が変わらないなら、ファイルの mtime を動かして同期を起こすだけ
      if (!pending || !shouldSave(pending.session, pending.body)) {
        return;
      }
      setSaveStatus("saving");
      try {
        await typedInvoke("update_draft", {
          filePath: pending.item.path,
          body: pending.body,
          client: await getDeviceSignals(),
        });
        recordSaved(localStorage, pending.item.filename, pending.session, pending.body);
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
    // 打鍵ごとに取り直すので、実際に走るのは最後の打鍵の写し
    const pending = snapshotSave();
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => void flushSave(pending), SAVE_DEBOUNCE_MS);
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
    ensureSession();
    setTapCaret(point);
    setDraft(noteBody());
    setSaveStatus("idle");
    setEditing(true);
  };

  /**
   * タイトルは本文先頭の H1 そのもの。打つたびに本文と同じ自動保存に乗せる。
   * 編集モードに入らないのは、エディタが持つのはタイトルを除いた本文だから。
   */
  const editTitle = (value: string): void => {
    ensureSession();
    setNoteTitle(value);
    scheduleSave();
  };

  /**
   * タイトル欄を離れたら、待っている保存を出しきって一覧を 1 度だけ
   * 読み直す。行に出ている題は本文の先頭行から導かれるので、
   * 読み直さないと一覧だけ古い題のまま残る。
   */
  const commitTitle = async (): Promise<void> => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    await flushSave();
    await refetchNotes();
  };

  /** プレビューのどこを押しても、その場所から書き始められる。 */
  const onPreviewClick = (e: MouseEvent): void => {
    if (editing() || noteView() !== "editor" || !selected()) {
      return;
    }
    const target = e.target instanceof Element ? e.target : null;
    // ノートリンクはこのアプリの中で解決する。href の無い a なので自前で開く
    const noteLink = target?.closest("a.note-link");
    if (noteLink instanceof HTMLElement && noteLink.dataset.file) {
      setSelectedId(noteLink.dataset.file);
      setDetailOpen(true);
      return;
    }
    // リンクは踏める・図はズームのまま・バックリンク欄は一覧のまま。
    // 編集に化けさせない
    if (target?.closest("a, button, .mermaid-block, .mermaid-zoom, .backlinks")) {
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
    const current = fullBody();
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
      shell.showToast(t().notes.revertFailed);
      return;
    }
    writeBackup(localStorage, item.filename, current);
    const titled = splitTitle(backup);
    batch(() => {
      setNoteTitle(titled.title);
      setNoteBody(titled.body);
    });
    shell.closePopovers();
    await refetchNotes();
    shell.showToast(t().notes.reverted);
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
    return backup !== null && backup !== fullBody();
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
    // 次に書き始めるときは新しいセッション。戻る先が 1 段ずつ進む
    sessionFile = null;
    await refetchNotes();
  };

  const createNote = async (): Promise<void> => {
    const path = await typedInvoke("create_draft", {
      body: "",
      tags: [],
      client: await getDeviceSignals(),
    });
    await refetchNotes();
    // 作ったノートを開く。選んだままにすると、そのまま題を打った人が
    // 前に開いていたノートの題を書き換えることになる
    const filename = path.split("/").at(-1);
    if (filename) {
      setSelectedId(filename);
    }
    setDetailOpen(true);
  };

  /**
   * テンプレから 1 本作って開く。同じテンプレの今日のぶんが既にあれば
   * core は作らずにそれを返す — そのときだけ、増えなかった理由を伝える。
   */
  const createFromTemplate = async (template: Template): Promise<void> => {
    shell.closePopovers();
    try {
      const created = await typedInvoke("create_from_template", {
        filename: template.filename,
        // 曜日の呼び名だけは端末の言語に従う。それを知っているのはここだけ
        locale: locale(),
        client: await getDeviceSignals(),
      });
      await refetchNotes();
      const filename = created.path.split("/").at(-1);
      if (filename) {
        setSelectedId(filename);
      }
      setDetailOpen(true);
      if (created.reused) {
        shell.showToast(t().templates.reused(template.name));
      }
    } catch {
      shell.showToast(t().templates.createFailed);
    }
  };

  /**
   * 触る端末では長押しがテンプレの入口。タップは今までどおり空のノートで、
   * 「開いてすぐ書ける」を 1 手増やさない。
   */
  const newNoteLongPress = createLongPress(() => shell.togglePopover("new-note-menu"));
  let newNotePointer = "mouse";

  // ---- 削除 + Undo（5秒は tombstone、経過後に本削除）----
  const remove = (item: NoteItem): void => {
    setHidden((ids) => [...ids, item.id]);
    setEditing(false);

    const commit = setTimeout(() => {
      void (async () => {
        await typedInvoke("delete_note", { filename: item.filename });
        await refetchNotes();
        setHidden((ids) => ids.filter((id) => id !== item.id));
        // タイムラインの origin チップはノート一覧から導出される。Undo の
        // 猶予中に他のビューへ移られるとこの refetch は届かないので、版を
        // 上げて向こうの一覧も読み直させる
        shell.refreshData();
      })();
    }, UNDO_MS);

    shell.showToast(t().notes.deleted, () => {
      clearTimeout(commit);
      setHidden((ids) => ids.filter((id) => id !== item.id));
    });
  };

  return (
    <div class="workspace" classList={{ "workspace--detail": detailOpen() }}>
      <div class="list-pane">
        <div class="list-pane-head">
          <span class="list-pane-title">NOTES</span>
          <button
            type="button"
            class="new-note long-press"
            aria-expanded={shell.popover() === "new-note-menu"}
            onPointerDown={(e) => {
              newNotePointer = e.pointerType;
              newNoteLongPress.onPointerDown(e);
            }}
            onPointerUp={newNoteLongPress.onPointerUp}
            onPointerMove={newNoteLongPress.onPointerMove}
            onPointerCancel={newNoteLongPress.onPointerCancel}
            onContextMenu={newNoteLongPress.onContextMenu}
            onClick={() => {
              // 長押しでメニューを開いた直後の click は飲み込む
              if (!newNoteLongPress.shouldClick()) {
                return;
              }
              if (newNotePointer === "mouse") {
                shell.togglePopover("new-note-menu");
              } else {
                void createNote();
              }
            }}
          >
            <Icon name="plus" size={12} />
            {t().notes.new}
          </button>
        </div>

        <Show when={shell.popover() === "new-note-menu"}>
          {/* 背後を暗くするのは下から出るシートのときだけ(CSS 側で出し分け) */}
          <div class="template-picker-backdrop" />
          <TemplatePicker
            templates={templates() ?? []}
            onPickEmpty={() => {
              shell.closePopovers();
              void createNote();
            }}
            onPick={(template) => void createFromTemplate(template)}
            onManage={() => {
              shell.closePopovers();
              navigate(ROUTES.TEMPLATES);
            }}
          />
        </Show>

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
        <Show when={selected()} fallback={<div class="detail-empty">{t().notes.noSelection}</div>}>
          {(item) => (
            <>
              <div class="detail-meta-bar">
                <button
                  type="button"
                  class="icon-button detail-back"
                  aria-label={t().notes.backToList}
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
                      {saveStatus() === "saving" ? t().common.saving : t().common.saved}
                    </span>
                  </Show>
                </span>

                <div class="detail-actions">
                  <Show when={!editing()}>
                    <button
                      type="button"
                      class="icon-button"
                      title={
                        noteView() === "mindmap" ? t().notes.showEditor : t().notes.showMindmap
                      }
                      aria-label={
                        noteView() === "mindmap" ? t().notes.showEditor : t().notes.showMindmap
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
                    title={t().notes.info}
                    aria-label={t().notes.info}
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
                      title={t().notes.finishEditing}
                      aria-label={t().notes.finishEditing}
                      onClick={() => void stopEditing()}
                    >
                      <Icon name="check" size={17} />
                    </button>
                  </Show>
                  <button
                    type="button"
                    class="icon-button"
                    title={t().common.delete}
                    aria-label={t().common.delete}
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

              {/* タイトルは本文先頭の H1 そのもの。ここで打ったものが
                  `# 見出し` として本文に書き戻る(`note-title.ts`)ので、
                  エディタとプレビューはタイトル行を持たない */}
              <input
                type="text"
                class="note-title-input"
                placeholder={t().notes.titlePlaceholder}
                aria-label={t().notes.titlePlaceholder}
                value={noteTitle()}
                onInput={(e) => editTitle(e.currentTarget.value)}
                onChange={() => void commitTitle()}
                onKeyDown={(e) => {
                  // 変換確定の Enter は IME のもの (#102)
                  if (e.key === "Enter" && !isImeComposing(e)) {
                    e.preventDefault();
                    startEditing();
                  }
                }}
              />

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
                      fallback={
                        <>
                          <MarkdownPreview source={noteBody()} noteTitles={noteTitles()} />
                          {/* このノートを指している記録。畳んだ 1 行以上の場所は取らない */}
                          <Show when={(backlinks() ?? []).length > 0}>
                            <details class="backlinks">
                              <summary class="backlinks-summary">
                                {t().notes.backlinks((backlinks() ?? []).length)}
                              </summary>
                              <div class="backlinks-list">
                                <For each={backlinks()}>
                                  {(hit) => (
                                    <button
                                      type="button"
                                      class="backlink-row"
                                      onClick={() => openBacklink(hit)}
                                    >
                                      <Icon
                                        name={hit.kind === "note" ? "file-text" : "lightning"}
                                        size={14}
                                      />
                                      <span class="backlink-title">{hit.title || hit.snippet}</span>
                                      <span class="backlink-date">{formatMonthDay(hit.date)}</span>
                                    </button>
                                  )}
                                </For>
                              </div>
                            </details>
                          </Show>
                        </>
                      }
                    >
                      {/* マインドマップの根は H1。タイトルを外した本文を
                          渡すと、根の無い枝だけの図になる */}
                      <MindmapView source={fullBody()} />
                    </Show>
                  }
                >
                  <MilkdownEditor
                    placeholder={t().notes.bodyPlaceholder}
                    caret={tapCaret()}
                    noteLinks={linkTargets}
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
