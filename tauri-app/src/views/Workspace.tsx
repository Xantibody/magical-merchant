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
  onMount,
  onCleanup,
} from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import type { Editor } from "@milkdown/kit/core";
import Icon from "../components/Icon";
import MarkdownPreview from "../components/MarkdownPreview";
import NoteMenu from "../components/NoteMenu";
import NoteMetaPopover from "../components/NoteMetaPopover";
import TemplatePicker from "../components/TemplatePicker";
import VersionSlider from "../components/VersionSlider";
import VersionSpine from "../components/VersionSpine";
import { isStaleSave, typedInvoke } from "../lib/commands";
import { refusalToast, refusedForGood } from "../lib/save-refusal";
import type { RefusedScreen } from "../lib/save-refusal";
import { getDeviceSignals } from "../lib/client-context";
import { createDebouncedAccessor } from "../lib/debounce";
import { markedBody } from "../lib/diff-marks";
import { glyphs } from "../lib/glyphs";
import { useShell } from "../lib/shell";
import {
  groupNotes,
  itemTitle,
  neighborOf,
  noteCreatedLabel,
  noteRowStamp,
  stepNote,
  toNoteItems,
} from "../lib/items";
import type { ItemGroup, NoteItem } from "../lib/items";
import { readNoteContent, viewToFrontmatter } from "../lib/note-view";
import type { NoteView } from "../lib/note-view";
import { joinTitle, splitTitle } from "../lib/note-title";
import { formatClock, formatMonthDay } from "../lib/day-labels";
import { locale, t } from "../lib/i18n";
import { isImeComposing } from "../lib/ime";
import { createLongPress } from "../lib/long-press";
import { isTypingTarget, matchesShortcut, shortcutLabel } from "../lib/shortcuts";
import { daysSince, spanSince, withDeltas } from "../lib/versions";
import type { VersionRow } from "../lib/versions";
import {
  beginEditSession,
  readBackup,
  recordSaved,
  shouldSave,
  tryWriteBackup,
  writeBackup,
} from "../lib/edit-backup";
import type { EditSession } from "../lib/edit-backup";
import type { NoteLinkTarget } from "../lib/note-link-plugin";
import type { NoteKind, SearchHit, Template, VersionStatus } from "../lib/commands";
import { noteRoute } from "../lib/note-route";
import { HIT_ICONS, MODE_LABELS, ROUTES } from "../lib/routes";
import "../styles/workspace.css";

// Milkdown + ProseMirror は詳細を開くまで要らない。一覧だけを見ている画面を
// この重さから切り離す(狭い端末では一覧と詳細が入れ替わるので、開くまで来ない)
const MilkdownEditor = lazy(() => import("../components/MilkdownEditor"));
const MarkdownToolbar = lazy(() => import("../components/MarkdownToolbar"));
// markmap-view は d3 を連れてくる。マインドマップにしたノートを開くまで読まない
const MindmapView = lazy(() => import("../components/MindmapView"));

const UNDO_MS = 5000;
const SAVE_DEBOUNCE_MS = 1000;
/** 「保存しました」を出しておく時間。過ぎたら保存時刻の表示に落ちる。 */
const SAVED_MS = 2000;
/** 並べたマップが打鍵に追いつくまでの間。保存(1 秒)より先に図が追いつく。 */
const MAP_DEBOUNCE_MS = 300;
/** 一覧の中で隣の行へ送るキーと、その向き。 */
const LIST_STEP_KEYS: Readonly<Record<string, 1 | -1>> = { ArrowUp: -1, ArrowDown: 1 };

async function loadNotes(): Promise<NoteItem[]> {
  return toNoteItems(await typedInvoke("list_notes"));
}

function EmptyNotes(props: { kind: NoteKind }): JSX.Element {
  const words = (): { empty: string; emptyHint: string } =>
    props.kind === "codex" ? t().codex : t().notes;
  return (
    <div class="notes-empty">
      <Icon name={props.kind === "codex" ? "book" : "note-pencil"} size={24} />
      <p class="notes-empty-title">{words().empty}</p>
      <p class="notes-empty-body">{words().emptyHint}</p>
    </div>
  );
}

/**
 * 一覧の行の右端、日付の左に置く角折りのページ。中に版の数。枠の色が
 * 「版なし / 版あり / 下書きが動いている」を言う。字は足さない — 行は 1 行のまま。
 */
function PageMark(props: { count: number; dirty: boolean }): JSX.Element {
  const state = (): "none" | "clean" | "dirty" => {
    if (props.count === 0) {
      return "none";
    }
    return props.dirty ? "dirty" : "clean";
  };
  return (
    <span
      class="page-mark"
      data-state={state()}
      title={t().codex.pageMark(props.count, props.dirty)}
      aria-hidden="true"
    >
      <span class="page-mark-face" />
      <Show when={props.count > 0}>
        <span class="page-mark-fold" />
        <span class="page-mark-count">{props.count}</span>
      </Show>
    </span>
  );
}

/** メタ行の「版 4 から +312 B」。動いていなければ「版 4」、無ければ「版なし」。 */
function versionStatusLabel(status: VersionStatus): string {
  if (status.count === 0) {
    return t().codex.noVersions;
  }
  return status.dirty
    ? t().codex.deltaFromLatest(status.count, status.bytes_delta)
    : t().codex.versionN(status.count);
}

/** このノートを指している記録。畳んだ 1 行以上の場所は取らない。 */
function Backlinks(props: { hits: SearchHit[]; onOpen: (hit: SearchHit) => void }): JSX.Element {
  return (
    <Show when={props.hits.length > 0}>
      <details class="backlinks">
        <summary class="backlinks-summary">{t().notes.backlinks(props.hits.length)}</summary>
        <div class="backlinks-list">
          <For each={props.hits}>
            {(hit) => (
              <button type="button" class="backlink-row" onClick={() => props.onOpen(hit)}>
                <Icon name={HIT_ICONS[hit.kind]} size={14} />
                <span class="backlink-title">{hit.title || hit.snippet}</span>
                <span class="backlink-date">{formatMonthDay(hit.date)}</span>
              </button>
            )}
          </For>
        </div>
      </details>
    </Show>
  );
}

/**
 * 本文の右に並べるマップ。打鍵のたびに図を組み替えると、書いている横で
 * 枝が跳ね続けるので、手が止まってから追いつかせる。
 */
function NoteMap(props: { source: () => string }): JSX.Element {
  const source = createDebouncedAccessor(props.source, MAP_DEBOUNCE_MS);
  return (
    <aside class="detail-map" aria-label={t().notes.layMap}>
      {/* マインドマップの根は H1。タイトルを外した本文を渡すと、
          根の無い枝だけの図になる */}
      <MindmapView source={source()} />
    </aside>
  );
}

interface WorkspaceProps {
  /** どの面か。同じ画面が `/notes` と `/codex` の両方に載る。 */
  kind?: NoteKind;
}

export default function Workspace(props: WorkspaceProps): JSX.Element {
  const kind = (): NoteKind => props.kind ?? "note";
  const shell = useShell();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const today = new Date();

  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [detailOpen, setDetailOpen] = createSignal(false);
  const [saveStatus, setSaveStatus] = createSignal<"idle" | "saving" | "saved" | "savedAt">("idle");
  /** 最後に保存できた時刻。「21:40 に保存」の数字。 */
  const [savedAt, setSavedAt] = createSignal("");
  const [hidden, setHidden] = createSignal<string[]>([]);
  /**
   * 先頭 H1 を切り離した本文。エディタが打鍵のたびに書き戻すので、いつでも
   * 画面に出ている本文と同じ — 読み取り専用に切り替えた瞬間のプレビューも、
   * マップも、これを読めば直前まで打っていた本文になる。
   */
  const [noteBody, setNoteBody] = createSignal("");
  /** 本文先頭の H1。タイトル欄が編集し、保存のたびに本文へ書き戻す。 */
  const [noteTitle, setNoteTitle] = createSignal("");
  const [noteView, setNoteView] = createSignal<NoteView>("editor");
  /**
   * 履歴を開いているか。Codex だけ。開くと背骨が広がり、本文は読み取り専用に
   * なって、選んだ版との差が欄外の印になる。本文は消えない。
   */
  const [historyOpen, setHistoryOpen] = createSignal(false);
  /** 履歴で選んでいる版。開いた瞬間は最新の版。 */
  const [selectedVersionId, setSelectedVersionId] = createSignal<string | null>(null);
  /** 本文の読み込みが済んでいるノートの id。`?edit=1` の自動フォーカスが待つ。 */
  const [loadedId, setLoadedId] = createSignal<string | null>(null);
  /**
   * 本文を外から入れ替えた回数。エディタは自分が持っている文書を正とするので、
   * 別のノートを開いた・同期で降ってきた・編集前に戻した、のどれかで
   * 画面の本文が変わったときは作り直すしかない(本文の差し込みは
   * カーソル・選択・IME を壊す)。この値をキーにして作り直す。
   *
   * 同時に「いまの読み込みセッション」の名前でもある。1 つの値は 1 回の
   * `showBody` — つまり 1 つのノートの 1 回の読み込み — にしか対応しないので、
   * 揃っていれば画面にあるのはそのとき出した本文とその後の打鍵だけ。
   * 断られた保存の退避(`typedBody`)がこれを見る。
   */
  const [bodyEpoch, setBodyEpoch] = createSignal(1);
  /** タッチ端末のツールバーが叩く先。ノートを開いていない間は undefined。 */
  const [markdownEditor, setMarkdownEditor] = createSignal<Editor | undefined>();

  const [notes, { refetch: refetchNotes }] = createResource(loadNotes);
  // 「新規」を押すまで開かないが、押した瞬間に読み始めると空のメニューが
  // 一度描かれる。件数は数件で、一覧と一緒に取っても目に見える差は出ない
  const [templates, { refetch: refetchTemplates }] = createResource(() =>
    typedInvoke("list_templates"),
  );

  let detailBodyRef: HTMLDivElement | undefined;
  let listScrollRef: HTMLDivElement | undefined;
  /** いま開いている編集セッション。保存のスキップ判断とバックアップを持つ。 */
  let session = beginEditSession("");
  /** そのセッションがどのノートのものか。null なら開いていない。 */
  let sessionFile: string | null = null;
  /**
   * ノートごとの、最後に読んだ(または書いた)本文の指紋。保存に添えると、
   * CLI や MCP がそのあいだに書き換えていれば断られる。ノート単位で持つ
   * のは、保存が遅れて届く頃には別のノートが選ばれていることがあるから。
   */
  const revisions = new Map<string, string>();
  /**
   * 走っている自動保存のタイマー。「まだディスクに無い本文がある」の合図で、
   * 読み直しを抑える判断がこれを読む。他の編集セッションの状態と一緒に置く。
   */
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** 「保存しました」を保存時刻の表示に落とすタイマー。 */
  let savedTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * いま人が本文を書いている最中か。エディタは開きっぱなしなので、
   * 「編集モードに入っているか」では区別が付かない。まだディスクに無い
   * 打鍵があるか、本文にカーソルが入っているかで見る — どちらの場合も
   * 本文を差し替えるとカーソル・選択・IME ごと壊す(editor skill)。
   */
  const isTyping = (): boolean =>
    Boolean(saveTimer) || Boolean(detailBodyRef?.contains(document.activeElement));

  /**
   * 一覧と詳細が並んでいる幅か。狭い端末では詳細を開くまで本文は画面に無いので、
   * そこで Milkdown を立ち上げると、一覧を見ているだけの人に ProseMirror 一式を
   * 読ませることになる。
   */
  const wideEnough = globalThis.matchMedia("(min-width: 768px)");
  const [twoPane, setTwoPane] = createSignal(wideEnough.matches);
  const onWidthChange = (e: MediaQueryListEvent): void => {
    setTwoPane(e.matches);
  };
  wideEnough.addEventListener("change", onWidthChange);
  onCleanup(() => wideEnough.removeEventListener("change", onWidthChange));

  /** 本文が実際に画面に出ているか。出ていないうちはエディタも作らない。 */
  const bodyVisible = createMemo<boolean>(() => twoPane() || detailOpen());

  /**
   * 背骨を 200px に広げて本文の横に並べられる幅か。マップと同じ境で、
   * 足りなければ背骨は 56px のままにして、履歴は題の下の横向きのカードで送る。
   */
  const spineRoom = globalThis.matchMedia("(min-width: 1100px)");
  const [spineWide, setSpineWide] = createSignal(spineRoom.matches);
  const onSpineRoomChange = (e: MediaQueryListEvent): void => {
    setSpineWide(e.matches);
  };
  spineRoom.addEventListener("change", onSpineRoomChange);
  onCleanup(() => spineRoom.removeEventListener("change", onSpineRoomChange));

  // 一覧は両方の置き場を 1 度に持ってくる。面ごとに絞るのはここ — IPC を
  // 面の数だけ増やすより、`?file=` の転送先を知るために全部持っているほうがいい
  const allItems = createMemo<NoteItem[]>(() => {
    const dropped = new Set(hidden());
    return (notes() ?? []).filter((item) => !dropped.has(item.id));
  });
  const visibleItems = createMemo<NoteItem[]>(() =>
    allItems().filter((item) => item.kind === kind()),
  );

  /**
   * ID しか知らない入口(`?file=`・`[[リンク]]`・バックリンク)の相手が
   * どの面に居るか。一覧が届く前は分からないので undefined。
   */
  const kindOf = (filename: string): NoteKind | undefined =>
    notes()?.find((item) => item.filename === filename)?.kind;

  const groups = createMemo<ItemGroup[]>(() => groupNotes(visibleItems(), today));

  const selected = createMemo<NoteItem | undefined>(() => {
    const items = visibleItems();
    return items.find((item) => item.id === selectedId()) ?? items[0];
  });

  /**
   * いま見ているノートの id。一覧を取り直すと NoteItem は作り直されるので、
   * 「見ているノートが変わった」を item の同一性で判断すると、保存や同期の
   * たびに変わったことになる。id なら同じノートのあいだ動かない。
   */
  const selectedKey = createMemo<string | undefined>(() => selected()?.id);

  /**
   * 画面の本文が、いま選んでいるノートのものか。選択を移してから本文が
   * 届くまでは前のノートの題と本文が残っていて、そこへ打った字は
   * 「前のノートの本文 + 打った字」として隣のノートへ向かう。初めて開く
   * 相手には revision も無いので core も止められない。書く・保存する入口は
   * 全部これを見る。
   */
  const loaded = (): boolean => loadedId() === selected()?.id;

  /** 読むだけのノート。frontmatter の `view: preview` がそう言っている。 */
  const readOnly = createMemo<boolean>(() => noteView() === "preview");
  /** マップを並べているか。同じ `view` キーに `mindmap` として憶えてある。 */
  const mapOpen = createMemo<boolean>(() => noteView() === "mindmap");

  /**
   * ファイルに書く本文。タイトル欄とエディタは別々に見せているが、
   * 保存・バックアップ・マインドマップが扱うのは常に結合した全文。
   */
  const fullBody = (): string => joinTitle(noteTitle(), noteBody());

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

  /**
   * `[[ID]]` → タイトルの解決表。プレビューが毎回これを引いて描く。
   * 面で絞らない — Note から Codex へ移した相手も、リンクは同じ ID のまま
   * 指し続けるし、開けば向こうの面へ送られる。
   */
  const noteTitles = createMemo<ReadonlyMap<string, string>>(
    () => new Map(allItems().map((item) => [item.filename.replace(/\.md$/u, ""), item.title])),
  );

  /** `[[` 補完の候補。両方の面から。自分自身へのリンクは出さない。 */
  const linkTargets = (): NoteLinkTarget[] =>
    allItems()
      .filter((item) => item.id !== selected()?.id)
      .map((item) => ({ id: item.filename.replace(/\.md$/u, ""), title: item.title }));

  // このノートを [[ID]] で指している記録。開くたびに走査で導出される
  const [backlinks] = createResource(
    () => selected()?.filename,
    (filename) => typedInvoke("find_backlinks", { filename }),
  );

  // 版の数と「最新の版からどれだけ動いたか」。本文を版と比べるので、開いて
  // いる 1 本ぶんだけ読む(一覧の行の印は core が名前の指紋だけで出している)
  const [versionStatus, { refetch: refetchVersionStatus }] = createResource(
    () => (kind() === "codex" ? selected()?.filename : undefined),
    (filename) => typedInvoke("note_version_status", { filename }),
  );
  // 版そのもの。背骨は畳んでいても版の数だけ点を打つので、Codex を開いたら読む
  const [versions, { refetch: refetchVersions }] = createResource(
    () => (kind() === "codex" ? selected()?.filename : undefined),
    (filename) => typedInvoke("list_note_versions", { filename }),
  );
  const versionRows = createMemo<VersionRow[]>(() => withDeltas(versions() ?? []));

  /** 版が増減したら、数と背骨と一覧の印を一緒に読み直す。 */
  const refreshVersions = (): void => {
    void refetchVersionStatus();
    void refetchVersions();
  };

  // 選んだ版から下書きへの差分。履歴を開いているあいだだけ
  const [diff] = createResource(
    () => {
      const id = selectedVersionId();
      const filename = selected()?.filename;
      return historyOpen() && id !== null && filename ? { filename, from: id } : undefined;
    },
    (args) => typedInvoke("diff_note_versions", args),
  );

  /**
   * 欄外の印を打った本文。差分が空(同じ内容)なら印は無く、本文はそのまま。
   * 履歴を開くときに保存を出しきってあるので、画面の本文はディスクと同じ。
   */
  const marked = createMemo(() => {
    const text = diff();
    return text ? markedBody(fullBody(), text) : undefined;
  });
  /** 選んだ版が下書きと同じ。背骨の 2 行目が「同じ内容」と言う。 */
  const sameAsDraft = (): boolean => selectedVersionId() !== null && !diff.loading && diff() === "";

  /** 「9 か月で 4 回刻んだ」。最初の版からの経過は版の一覧から。 */
  const cadence = (): string | undefined => {
    const rows = versionRows();
    const oldest = rows.at(-1);
    return oldest
      ? t().codex.cadence(rows.length, spanSince(oldest.version.time, new Date()))
      : undefined;
  };

  /**
   * 画面に出ている本文をまるごと入れ替える。エディタは自分の文書を正とするので、
   * ここを通ったら作り直す(`bodyEpoch`)。バラして流すと一瞬だけ違うモードで
   * 描かれるので、題・本文・モードは 1 度に置く。
   */
  const showBody = (id: string, title: string, body: string, view: NoteView): void => {
    // 「保存しました」の 2 秒は前のノートの持ち物。持ち越すと、保存していない
    // ノートに「21:40 に保存」が出る
    clearTimeout(savedTimer);
    batch(() => {
      setNoteTitle(title);
      setNoteBody(body);
      setNoteView(view);
      setLoadedId(id);
      setBodyEpoch((epoch) => epoch + 1);
      setSaveStatus("idle");
    });
  };

  /**
   * ディスクから読み直して画面に出す。選択の切り替えと、外からの書き換えの後に。
   * `force` は「打った字はもう退避してあるので、書いている最中でも譲る」の合図。
   *
   * 返るのは「読み直しを実際に画面へ載せたか」。読めなかったぶんと、届く前に
   * 選択が移って見送ったぶんは `false` — 呼ぶ側が「読み直しました」と言う前に
   * 確かめられるように、載せたかどうかはここからしか分からない。
   */
  const loadNote = async (item: NoteItem, force = false): Promise<boolean> => {
    try {
      const content = await readNoteContent(
        () => typedInvoke("read_note", { filename: item.filename }),
        () => typedInvoke("read_note_meta", { filename: item.filename }),
      );
      // 一覧を素早くたどると、遅い読みが速い読みを追い越して届く。
      // いま選ばれているノートへの答えだけを画面に出す。読み始める前に
      // 確かめた「編集中でも保存待ちでもない」も、届いた時点でもう一度見る —
      // 応答を待つあいだにタップして書き始められる。
      // revision まで見送るのは、画面に出していない版で保存に行くと、
      // 読んでいない相手の本文の上に書けてしまうから
      if (selected()?.id !== item.id || (!force && isTyping())) {
        return false;
      }
      revisions.set(item.filename, content.revision);
      // 本文とモードは対で出す。バラすと一瞬だけ違うモードで描かれる
      const titled = splitTitle(content.body);
      showBody(item.id, titled.title, titled.body, content.view);
      return true;
    } catch {
      // 読めなかったことを本文の入れ替えにしない。空のエディタを立てると
      // 「空のノート」に見え、そこへ打った数文字がノート全体になる。
      // `loadedId` を進めないので、本文も題も書ける状態にならない
      if (selected()?.id === item.id && (force || !isTyping())) {
        shell.showToast(t().notes.loadFailed);
      }
      return false;
    }
  };

  // ---- 選択中ノートの本文と表示モードを読む ----
  // 追うのは「どのノートを見ているか」だけ。item そのものを追うと、一覧を
  // 取り直すたびに本文を読み直し、開いているエディタの下で本文が入れ替わる
  createEffect(
    on(selectedKey, () => {
      const item = selected();
      // 別のノートに移ったら編集セッションは畳む。戻る先が前のノートの
      // 本文のままだと、次の保存が他人のバックアップを潰す
      sessionFile = null;
      // 履歴は開いていたノートの持ち物
      setHistoryOpen(false);
      setSelectedVersionId(null);
      if (!item) {
        showBody("", "", "", "editor");
        return;
      }
      // 届くまでは「まだ誰の本文でもない」。前のノートのエディタは畳み、
      // 題も書けなくする。先に空のエディタを立てて本文と一緒に作り直す
      // より、届いてから 1 度だけ立てるほうが軽い
      setLoadedId(null);
      // 別のノートを開いたのは人の意思。待っている保存は `settleEdit` が
      // 出しきったあとなので、カーソルが本文に残っていても譲ってよい
      void loadNote(item, true);
    }),
  );

  /**
   * 表示モードを憶えさせる。`view` は 1 つのキーなので、読み取り専用と
   * マップは同時には立たない — 後から押したほうが残る。
   */
  const setView = async (item: NoteItem, next: NoteView): Promise<void> => {
    const previous = noteView();
    // 保存を待たずに切り替える。書き込みは frontmatter が壊れたノートで
    // 失敗し得るので、そのときは表示だけ戻す
    setNoteView(next);
    shell.closePopovers();
    try {
      await typedInvoke("set_note_view", {
        filename: item.filename,
        view: viewToFrontmatter(next),
      });
      await refetchNotes();
    } catch {
      setNoteView(previous);
    }
  };

  const toggleReadOnly = (item: NoteItem): Promise<void> =>
    setView(item, readOnly() ? "editor" : "preview");

  const toggleMap = (item: NoteItem): Promise<void> =>
    setView(item, mapOpen() ? "editor" : "mindmap");

  // ---- 編集（自動保存: 1秒 debounce + 直列化）----
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
    /** 写しを取った時点の世代。読み直しをまたいだ写しは書かない。 */
    generation: number;
    /**
     * 写しを取った時点の `bodyEpoch`。断られたときに「画面の本文はまだこの
     * 写しの続きか」を見るのに使う。ノートの id では足りない — A → B → A と
     * 戻れば id は揃うのに、本文は B のものか A を読み直したものになっている。
     */
    bodyEpoch: number;
  }

  /**
   * 保存の世代。外からの書き換えに譲って読み直すたびに 1 つ進める。
   * 譲るより前に `saveChain` に並んだ写しは、読み直した版を知らないまま
   * 順番が来る。そのまま書くと、いま画面に出ている相手の本文を古い draft で
   * 潰す — 読み直しで `revisions` が新しくなっているので core も止められない。
   * `session.lastSavedBody` を合わせるだけでは「同じ本文の写し」しか止まらない。
   */
  let saveGeneration = 0;

  const snapshotSave = (): PendingSave | undefined => {
    const item = selected();
    // 本文が届いていないノートには写しを取らない。画面にあるのは前のノート
    return item && loaded()
      ? { item, body: fullBody(), session, generation: saveGeneration, bodyEpoch: bodyEpoch() }
      : undefined;
  };

  /**
   * 一覧の行に出る題がディスクと食い違っているか。保存が着地するたびに立て、
   * 読み直したら下ろす。「待っている保存があるか」で代用すると、自動保存が
   * 先に着地していたときに読み直しが飛ばされ、行だけ古い題のまま残る。
   */
  let listStale = false;

  const refreshListIfStale = async (): Promise<void> => {
    if (!listStale) {
      return;
    }
    listStale = false;
    await refetchNotes();
  };

  /**
   * 保存できた合図。緑の「保存しました」を出しっぱなしにすると、書いている
   * あいだじゅう視界の端が光る。2 秒だけ出して、あとは時刻に落ち着かせる。
   */
  const markSaved = (): void => {
    clearTimeout(savedTimer);
    batch(() => {
      setSavedAt(formatClock(new Date()));
      setSaveStatus("saved");
    });
    savedTimer = setTimeout(() => setSaveStatus("savedAt"), SAVED_MS);
  };

  /**
   * 断られた保存から退避する本文。飛んでいった写しではなく、いま画面にある
   * ぶん — 端末の信号待ちと IPC の往復のあいだに打った字は、まだファイルにも
   * 控えにも無い。写しのほうを退避すると、その打鍵だけが黙って消える。
   *
   * ただし画面のぶんを使えるのは、写しを取った読み込みがまだ続いている
   * あいだだけ。見るのは `bodyEpoch` — ノートの id を見ても、往復のあいだに
   * A → B → A と移れば id は揃ったまま、画面の本文は B のものか A を
   * 読み直したものになっている。それを退避すると、断られた打鍵ごと A の
   * 控えを別のノートの本文で潰す。epoch は本文を外から入れ替えるたびに
   * 進むので、揃っているなら画面にあるのは「この写し + その後の打鍵」だけ。
   */
  const typedBody = (pending: PendingSave): string =>
    bodyEpoch() === pending.bodyEpoch ? fullBody() : pending.body;

  /**
   * 断られた保存のあと、画面に何が出ているか。譲る前の姿ではなく、読み直しが
   * 済んだ「いま」を見る — 読めずに引き返すことも、往復のあいだに隣へ
   * 移られることもあり、そのどちらでも画面は譲る前と違う。
   *
   * 打鍵がまだ画面に在るかは `bodyEpoch` で見る(`typedBody` と同じ理由)。
   * 読み直しが載れば epoch は進むが、A → B → A と戻って別の読み込みが
   * 載った場合も進む — どちらも「画面にもう打った字は無い」で同じ扱いでよい。
   */
  const refusedScreen = (pending: PendingSave, reloaded: boolean): RefusedScreen => {
    if (selected()?.id !== pending.item.id) {
      return "away";
    }
    return reloaded || bodyEpoch() !== pending.bodyEpoch ? "reloaded" : "draft";
  };

  /**
   * 読んでから書くまでに、CLI や MCP が同じノートを書き換えていた。
   * 相手の本文の上には書かず、打った字はこの端末のバックアップに退避して
   * ディスクの本文を読み直す。「戻す」を押せば退避した本文と入れ替わる —
   * 相手の版がバックアップに回るので、どちらも失わない。
   *
   * 読み直すのは、譲ったノートがまだ選ばれているときだけ。往復のあいだに
   * 隣へ移っていれば画面にあるのは別のノートで、そこへディスクの本文を
   * 流し込むわけにはいかない。言い分もそれに合わせる — 断られた保存の
   * 言い分は `refusalToast` が一手に決める。
   */
  const yieldToOutsideEdit = async (pending: PendingSave, error: unknown): Promise<void> => {
    // 「戻す」で呼び出せると言う前に、控えが実際に残ったかを見る。
    // 満杯・無効の localStorage では残らず、そこで約束すると人は信じて閉じる
    const kept = tryWriteBackup(localStorage, pending.item.filename, typedBody(pending));
    saveGeneration += 1;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    let reloaded = false;
    if (selected()?.id === pending.item.id) {
      sessionFile = null;
      reloaded = await loadNote(pending.item, true);
    }
    await refetchNotes();
    shell.showToast(
      refusalToast(error, kept, pending.item.title, refusedScreen(pending, reloaded)),
    );
  };
  const flushSave = (pending = snapshotSave()): Promise<void> => {
    const previous = saveChain;
    saveChain = (async () => {
      await previous;
      // 触っていない誤タップのセッションを書き込みに変えない。書いても
      // 内容が変わらないなら、ファイルの mtime を動かして同期を起こすだけ。
      // 読み直しをまたいだ写しも書かない(世代が置いていかれている)
      if (
        !pending ||
        pending.generation !== saveGeneration ||
        !shouldSave(pending.session, pending.body)
      ) {
        return;
      }
      // 保存の様子はそのノートの持ち物。書き込みが遅い端末では、隣へ移った
      // あとに着地することがあり、そのまま出すと開いたばかりのノートが
      // 「保存しました」と言う。画面に出ているノートの保存のときだけ出す
      const shown = (): boolean => selected()?.id === pending.item.id;
      // 指紋を持たないノートには書かない。`revision` 無しの保存は core の
      // 照合を素通りするので、読めていない本文の上に画面のぶんを丸ごと
      // 書いてしまう。読み直しが通れば指紋が入り、次の保存から書ける
      const expected = revisions.get(pending.item.filename);
      if (expected === undefined) {
        return;
      }
      if (shown()) {
        setSaveStatus("saving");
      }
      try {
        const revision = await typedInvoke("update_draft", {
          filename: pending.item.filename,
          body: pending.body,
          client: await getDeviceSignals(),
          revision: expected,
        });
        revisions.set(pending.item.filename, revision);
        recordSaved(localStorage, pending.item.filename, pending.session, pending.body);
        // 一覧はここでは読み直さない。1 秒おきの保存のたびに全ノートを
        // 読み直すのは低スペック端末に重く、編集中は一覧が見えてもいない。
        // 書く手が止まったときに 1 回だけ読み直す。
        listStale = true;
        if (shown()) {
          markSaved();
          // 「版 N から +X B」は最新の版と下書きの比較。書くたびに答えが変わる
          if (kind() === "codex") {
            void refetchVersionStatus();
          }
        }
      } catch (error) {
        if (shown()) {
          setSaveStatus("idle");
        }
        if (isStaleSave(error)) {
          await yieldToOutsideEdit(pending, error);
        } else if (refusedForGood(error)) {
          // どれも読み直しでは直らない。壊れた記録は書き直しても同じ理由で
          // 断られ、消えたノートは core が作り直さず、文字として読めない
          // ファイルは読む段で断られる。次の打鍵にも望みが無いので、打った字は
          // ここで退避して、黙って消えないようにする。
          // ディスクへは既に書けていないので、退避が残ったかまで確かめる —
          // 残らなかったのに「戻す」で呼び出せると言うと、人はそれを信じて
          // 閉じ、画面にしか無い唯一の写しごと失う
          const kept = tryWriteBackup(localStorage, pending.item.filename, typedBody(pending));
          // ここは読み直しを走らせない。画面にあるのは打鍵の続きか、別のノート
          shell.showToast(
            refusalToast(error, kept, pending.item.title, refusedScreen(pending, false)),
          );
        }
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
    saveTimer = setTimeout(() => {
      // 起きたタイマーは終わったタイマー。掃除しないと「保存待ちがある」が
      // 立ったままになり、フォーカス復帰の読み直しが二度と通らない
      saveTimer = undefined;
      void flushSave(pending);
    }, SAVE_DEBOUNCE_MS);
  };

  onCleanup(() => {
    clearTimeout(savedTimer);
    if (saveTimer) {
      clearTimeout(saveTimer);
      void flushSave();
    }
  });

  // 同期やパレット操作の後にデータを取り直す。初回は createResource が読むので
  // defer しないと全ノートの読み直しがマウント直後に二重で走る
  createEffect(
    on(
      shell.dataVersion,
      () => {
        void refetchNotes();
        void refetchTemplates();
        // 一覧を取り直しただけでは、開いたままのノートは古い本文を出し続ける。
        // 同期で降ってきた版をここで読み直す。読むだけで、書き戻しはしない
        const item = selected();
        // 書いている最中は絶対に触らない。本文の差し替えはカーソル・選択・
        // スクロール・IME の状態ごと壊す(editor skill)。待っている保存が
        // あるときも同じ — 打った字はまだディスクに無いので、読み直せば
        // それを捨てることになる。
        // どちらも次の Step(ファイル監視)でトーストを出して人に決めさせる
        if (item && !isTyping()) {
          void loadNote(item);
        }
        // 版も同期で増える。ファイル名は同じなので resource は自分では
        // 取り直さない
        if (kind() === "codex") {
          refreshVersions();
        }
      },
      { defer: true },
    ),
  );

  /**
   * 待っている保存を出しきってから離れる。選択を動かす手前で必ず通す道。
   * 出しきらずに移ると `fullBody()` が「次のノートの題 + 前のノートの本文」に
   * なり、次の保存がその混ぜ物を隣のノートへ書き込む。読み直しが
   * `revisions` を更新済みなので Stale でも止まらない。
   * 何も保存していないなら一覧も読み直さない — 行に出る題は変わっていない。
   */
  const settleEdit = async (): Promise<void> => {
    // 次に書き始めるときは新しいセッション。戻る先が 1 段ずつ進む
    sessionFile = null;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
      await flushSave();
    }
    // 行に出る題は本文の先頭行から導かれる。読み直さないと一覧だけ古い題のまま
    await refreshListIfStale();
  };

  /**
   * ファイルを動かす前の `settleEdit`。予約が無くても、発火済みの保存が端末の
   * 信号や書き込みをまだ待っていることがある。切り替えなら待たなくてよい
   * (保存は自分の path を持って着地する)が、rename の後に着地する書き込みは
   * 移動前の path に向かい、移した先には古い本文だけが残る。
   */
  const settleWrites = async (): Promise<void> => {
    await settleEdit();
    await saveChain;
  };

  /**
   * 選択を差し替える唯一の入口。一覧のタップ・ウィジェットの `?file=`・
   * 新規作成・テンプレ・バックリンクは全部ここを通る。入口ごとに
   * 「編集中だったらどうするか」を書くと、書き忘れた入口だけが前のノートの
   * 本文を次のノートへ持ち込む — 入口が増えても書く場所は 1 つにしておく。
   */
  async function switchTo(id: string): Promise<void> {
    await settleEdit();
    setSelectedId(id);
    setDetailOpen(true);
  }

  const select = (item: NoteItem): void => {
    shell.closePopovers();
    void switchTo(item.id);
  };

  /**
   * ID で指されたノートを開く。相手が別の面に居れば、その面へ送る —
   * この面の一覧に無い id を選んでも、先頭のノートに倒れるだけ。
   */
  const openFile = async (filename: string): Promise<void> => {
    const other = kindOf(filename);
    if (other && other !== kind()) {
      navigate(noteRoute(other, filename));
      return;
    }
    await switchTo(filename);
  };

  const openBacklink = (hit: SearchHit): void => {
    if (hit.kind !== "scrawl" && hit.filename) {
      void openFile(hit.filename);
    } else {
      navigate(`${ROUTES.SCRAWL}?day=${hit.date}`);
    }
  };

  // ウィジェットの行から `?file=` 付きで来たときだけ、その 1 件を開く。
  // 一覧が届く前に来ることがあるが、id はファイル名そのものなので先に置ける
  createEffect(
    on(
      () => searchParams.file,
      (file) => {
        if (typeof file === "string" && file) {
          void switchTo(file);
        }
      },
    ),
  );

  // ウィジェットや `[[リンク]]` は ID しか知らず `/notes?file=` に着く。相手が
  // Codex なら、一覧が届いた時点で `/codex?file=` へ置き換える。この面には
  // 居ないノートなので、履歴に残しても戻る先にならない
  createEffect(() => {
    const { file } = searchParams;
    if (typeof file !== "string" || !file) {
      return;
    }
    const other = kindOf(file);
    if (other && other !== kind()) {
      navigate(noteRoute(other, file), { replace: true });
    }
  });

  /** 本文にカーソルを置く。昇格直後のノートを、そのまま書ける形で渡す。 */
  const focusBody = (): void => {
    detailBodyRef?.querySelector<HTMLElement>(".ProseMirror")?.focus();
  };

  /**
   * タイトルは本文先頭の H1 そのもの。打つたびに本文と同じ自動保存に乗せる。
   */
  const editTitle = (value: string): void => {
    if (!loaded()) {
      return;
    }
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
    await refreshListIfStale();
  };

  /**
   * ノートリンクはこのアプリの中で解決する。href を持たない `a` なので、
   * 読むだけのノートでもマップでも、押されたことをここで拾って開く。
   */
  const onBodyClick = (e: MouseEvent): void => {
    const target = e.target instanceof Element ? e.target : null;
    const noteLink = target?.closest("a.note-link");
    if (noteLink instanceof HTMLElement && noteLink.dataset.file) {
      void openFile(noteLink.dataset.file);
    }
  };

  /**
   * この端末に残した「編集前の本文」と今の本文を入れ替える。入れ替えなので
   * もう一度押せば戻せる — 戻る先は常にちょうど 1 段。
   *
   * ディスクへ書けないノートでは入れ替えをやめ、控えを画面に出すだけにする。
   * 控えを作る理由(壊れた記録・消えたノート・文字として読めないファイル)は
   * そのまま書き込みを断る理由でもあるので、書けたときしか見せないと、退避は
   * 残っているのに取り出す道がどこにも無くなる。画面に出れば人は選んで写せる。
   */
  const revertEdit = async (item: NoteItem): Promise<void> => {
    const backup = readBackup(localStorage, item.filename);
    const current = fullBody();
    // 届く前の画面の本文は前のノートのもの。それを控えに回してはいけない
    if (!loaded() || backup === null || backup === current) {
      return;
    }
    // 待っている保存は捨てる。いま画面にある本文はこれから控えに回るので、
    // 同じものをもう一度ディスクへ書きに行く意味がない
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    let written = true;
    try {
      const revision = await typedInvoke("update_draft", {
        filename: item.filename,
        body: backup,
        client: await getDeviceSignals(),
        revision: revisions.get(item.filename) ?? null,
      });
      revisions.set(item.filename, revision);
    } catch (error) {
      // 読み直せば書けるノート(Stale・一時的な失敗)では見せずに終わる。
      // ディスクと画面が黙って食い違い、次の保存が相手の本文を控えで潰す
      if (!refusedForGood(error)) {
        shell.showToast(t().notes.revertFailed);
        return;
      }
      written = false;
    }
    if (written) {
      // 入れ替えたので、いまの「戻る先」は入れ替える前の本文。書けなかった
      // ときは入れ替えない — 控えはまだこの字の唯一の写しで、押すたびに
      // 同じものを出せる
      writeBackup(localStorage, item.filename, current);
    }
    // 控えを取り終えたセッションとして開き直す — 開き直さないと、次に題や
    // 本文を触ったときに新しいセッションが立ち上がり、その最初の保存が
    // 復元直前の本文を控えに書いて、もう一度押しても戻れなくなる
    session = beginEditSession(backup);
    session.committed = true;
    sessionFile = item.filename;
    const titled = splitTitle(backup);
    // エディタごと作り直す。差し込みでは戻した本文が画面に出ない
    showBody(item.id, titled.title, titled.body, noteView());
    shell.closePopovers();
    if (written) {
      // 行に出る題は本文の先頭行から導かれる。書いていないなら変わっていない。
      // 消えたノートではここで行ごと消え、出したばかりの控えが画面から落ちる
      await refetchNotes();
    }
    shell.showToast(written ? t().notes.reverted : t().notes.shownFromBackup);
  };

  /**
   * いまの下書きを版として刻む。ここが唯一の入口で、自動では刻まない。
   * 保存・離脱・昇格のどれにも掛けない — 版は人が「ここまで」と言った印。
   *
   * 押した瞬間に刻む。一言は聞かない — 版の名前は「版 N · 日付」で足り、
   * 聞くと刻むこと自体が億劫になる。代わりにトーストで要約を言い、
   * 猶予のあいだは取り消せる(版のファイルを消すだけ)。
   */
  const commitVersion = async (item: NoteItem): Promise<void> => {
    if (kind() !== "codex" || !loaded()) {
      return;
    }
    shell.closePopovers();
    // 刻むのはディスクの本文。飛んでいる保存を待たないと最後の打鍵が版に入らない
    await settleWrites();
    const before = versions() ?? [];
    let version;
    try {
      version = await typedInvoke("commit_note_version", {
        filename: item.filename,
        message: null,
      });
    } catch {
      shell.showToast(t().codex.commitFailed);
      return;
    }
    // 同じ秒に同じ本文を刻むと core は前の版をそのまま返す。増えていない
    // ものは取り消せない — 消すと前からあった版が消える
    const existed = before.some((v) => v.id === version.id);
    const [latest] = before;
    const count = existed ? before.length : before.length + 1;
    const summary = [
      latest
        ? t().codex.deltaFromLatest(before.length, version.bytes - latest.bytes)
        : t().codex.sizeOf(version.bytes),
      latest && daysSince(latest.time, new Date()) > 0
        ? t().codex.sinceDays(daysSince(latest.time, new Date()))
        : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    refreshVersions();
    // 一覧の角折りページも数と枠が変わる
    void refetchNotes();
    const undo = existed
      ? undefined
      : (): void => {
          void (async () => {
            try {
              await typedInvoke("delete_note_version", {
                filename: item.filename,
                id: version.id,
              });
            } catch {
              return;
            }
            refreshVersions();
            void refetchNotes();
          })();
        };
    shell.showToast(t().codex.committed(count), undo, summary);
  };

  /**
   * 履歴を開く前に、待っている保存を出しきる。履歴はディスクの本文と版を
   * 比べる画面で、「戻す」もディスクの本文を「戻す前」として刻む — 画面に
   * しか無い打鍵を残したまま開くと、その打鍵はどちらにも入らずに消える。
   * 開いた瞬間に選ぶのは最新の版。
   */
  const openHistory = async (): Promise<void> => {
    shell.closePopovers();
    if (historyOpen()) {
      return;
    }
    await settleWrites();
    // 版は他の端末でも刻まれる。比べる画面を開く瞬間は読み直しに安い。
    // 選ぶ最新の版は読み直した一覧から — 手元の一覧で選ぶと、届いた一覧に
    // その版が残っている限り、より新しい版があっても古いほうを開き続ける
    void refetchVersionStatus();
    const rows = (await refetchVersions()) ?? versions();
    batch(() => {
      setSelectedVersionId(rows?.[0]?.id ?? null);
      setHistoryOpen(true);
    });
  };

  const closeHistory = (): void => {
    batch(() => {
      setHistoryOpen(false);
      setSelectedVersionId(null);
    });
  };

  // 開いたときにまだ版が届いていなければ、届いた最新の版を選ぶ。取り消しで
  // 選んでいた版が消えたときも最新へ寄せる
  createEffect(() => {
    if (!historyOpen()) {
      return;
    }
    const rows = versions();
    if (!rows) {
      return;
    }
    const chosen = selectedVersionId();
    if (chosen === null || !rows.some((v) => v.id === chosen)) {
      setSelectedVersionId(rows[0]?.id ?? null);
    }
  });

  /**
   * 版の本文を下書きにする。core が先に「戻す前」を刻むので、戻したことも
   * 履歴から戻せる。書き込みは `update_draft` と同じ照合を通るので、
   * 読んでから外で書き換えられていれば同じ経路で譲る。
   */
  const restoreVersion = async (item: NoteItem, id: string): Promise<void> => {
    if (!loaded() || readOnly()) {
      return;
    }
    // 待っている保存は捨てる。戻すのはディスクの本文で、画面の打鍵は
    // 「戻す前」の版には入らないが、履歴を開いた時点で settleEdit 済み
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    // 画面に出ている本文を読んだときの指紋。読み直しが届かなかったときの戻る先
    const read = revisions.get(item.filename);
    try {
      const revision = await typedInvoke("restore_note_version", {
        filename: item.filename,
        id,
        client: await getDeviceSignals(),
        revision: read ?? null,
      });
      revisions.set(item.filename, revision);
    } catch (error) {
      if (isStaleSave(error)) {
        await yieldToOutsideEdit(
          {
            item,
            body: fullBody(),
            session,
            generation: saveGeneration,
            bodyEpoch: bodyEpoch(),
          },
          error,
        );
      } else {
        shell.showToast(t().codex.restoreFailed);
      }
      return;
    }
    // 戻した本文はディスクにある。読み直せば画面もそれになる
    sessionFile = null;
    closeHistory();
    const shown = await loadNote(item, true);
    if (!shown) {
      // 読み直しが画面へ届かなかった。戻した本文はディスクに在るのに、画面には
      // まだ戻す前の本文が出ている。指紋だけ戻した後のものにしておくと、次の
      // 打鍵の保存が core の照合を素通りし、いま戻した版を黙って潰す。
      // 指紋を「画面に出ている本文を読んだときのもの」へ戻し、対を崩さない。
      // 次の保存は Stale で断られ、打った字は控えに退避されて読み直しがもう一度
      // 走る(`yieldToOutsideEdit`)。
      // AIDEV-NOTE: 編集を止める案(`loadedId` を落とす)は捨てた。打った字ごと退避する既存の Stale の道に乗せるほうが失わない
      if (read === undefined) {
        revisions.delete(item.filename);
      } else {
        revisions.set(item.filename, read);
      }
    }
    await refetchNotes();
    refreshVersions();
    shell.showToast(shown ? t().codex.restored : t().codex.restoredNotShown);
  };

  // Scrawl からの昇格 (?edit=1) は、本文が届き次第そのまま書ける形で渡す。
  // パラメータは消費したら消す — 再読み込みのたびにカーソルを奪わない
  createEffect(() => {
    if (searchParams.edit !== "1") {
      return;
    }
    const item = selected();
    if (!item || item.filename !== searchParams.file || loadedId() !== item.id) {
      return;
    }
    // 読み取り専用にしたノートには本文欄そのものが無い。昇格直後の
    // ノートは view を持たないので実害は無いが、経路として塞いでおく
    if (readOnly()) {
      setSearchParams({ edit: undefined }, { replace: true });
      return;
    }
    // 本文が届いた時点では、まだ置く先が無い。エディタは lazy に読まれ、
    // ProseMirror の DOM は create の後にしか現れない。本文と一緒に作り
    // 直されるので(`bodyEpoch`)、ここで見えるのは今の本文のエディタだけ
    if (!markdownEditor()) {
      return;
    }
    focusBody();
    setSearchParams({ edit: undefined }, { replace: true });
  });

  const revertable = createMemo<boolean>(() => {
    const item = selected();
    if (!item) {
      return false;
    }
    const backup = readBackup(localStorage, item.filename);
    return backup !== null && backup !== fullBody();
  });

  /**
   * 開いているノートに効くキー。受けるのがここなのは、対象が「いま選んで
   * いる 1 件」だから — AppLayout の表はどの画面でも同じ意味を持つものだけ。
   *
   * ここの札は Milkdown と当たらないキーだけを選んである(#211)。それでも
   * エディタに先を譲る(`defaultPrevented`)のは、あとからエディタが取るキーが
   * 増えたときに、書いている最中の打鍵をこちらが横取りしないため。
   *
   * ⌘↑ / ⌘↓(文頭・文末へ)はブラウザ既定の動きで、誰も preventDefault
   * しない。こちらはカーソルが文字の中にあるかで見分ける。
   */
  onMount(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const item = selected();
      if (!item || e.defaultPrevented) {
        return;
      }
      const typing = isTypingTarget(e.target);
      const step = matchesShortcut(e, "notePrev") ? -1 : Number(matchesShortcut(e, "noteNext"));
      if (step !== 0) {
        if (typing) {
          return;
        }
        const next = stepNote(visibleItems(), item.id, step);
        if (next) {
          e.preventDefault();
          void switchTo(next);
        }
        return;
      }
      if (matchesShortcut(e, "noteActions")) {
        e.preventDefault();
        shell.togglePopover("note-menu");
      } else if (matchesShortcut(e, "noteMap")) {
        e.preventDefault();
        void toggleMap(item);
      } else if (matchesShortcut(e, "noteRevert")) {
        e.preventDefault();
        void revertEdit(item);
      } else if (matchesShortcut(e, "noteInfo")) {
        e.preventDefault();
        shell.togglePopover("note-meta");
      } else if (matchesShortcut(e, "codexCommit")) {
        e.preventDefault();
        void commitVersion(item);
      } else if (e.key === "Escape" && historyOpen()) {
        e.preventDefault();
        closeHistory();
      }
    };
    globalThis.addEventListener("keydown", onKeyDown);
    onCleanup(() => globalThis.removeEventListener("keydown", onKeyDown));
  });

  /**
   * 一覧の中の ↑ / ↓。一覧というウィジェットの中の操作なので、⌘ の表
   * (`SHORTCUTS`)には載せず、`.list-scroll` の中でだけ受ける — 本文の
   * 外で何も選ばずに押した ↑↓ はページのスクロールで、それは奪わない。
   * 一覧に入力欄は無いので、`isTypingTarget` の判定も要らない。
   *
   * フォーカスは `switchTo` の await を待たずに先に動かす。押した手応えを
   * 保存の完了まで遅らせない。行の背景は `selectedId` が変わると追いつく。
   */
  const onListKeyDown = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) {
      return;
    }
    const step = LIST_STEP_KEYS[e.key];
    if (step === undefined) {
      return;
    }
    // 端では何もしない。preventDefault もしないので、一覧のスクロールに落ちる
    const next = stepNote(visibleItems(), selected()?.id, step);
    if (!next) {
      return;
    }
    e.preventDefault();
    const row = listScrollRef?.querySelector<HTMLElement>(`[data-id="${CSS.escape(next)}"]`);
    row?.focus();
    row?.scrollIntoView({ block: "nearest" });
    void switchTo(next);
  };

  const createNote = async (): Promise<void> => {
    const path = await typedInvoke("create_draft", {
      body: "",
      tags: [],
      kind: kind(),
      client: await getDeviceSignals(),
    });
    await refetchNotes();
    // 作ったノートを開く。選んだままにすると、そのまま題を打った人が
    // 前に開いていたノートの題を書き換えることになる
    const filename = path.split("/").at(-1);
    if (filename) {
      await switchTo(filename);
    }
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
      // 「同じテンプレの今日の 1 本」が Codex になっていることもある。
      // この面の一覧に無い id を選ぶと先頭のノートに倒れるので、面ごと送る
      if (filename) {
        await openFile(filename);
      }
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
  const newNoteLongPress = createLongPress(() => {
    if (kind() === "note") {
      shell.togglePopover("new-note-menu");
    }
  });
  let newNotePointer = "mouse";

  /**
   * Note を Codex の置き場へ移す。ID も本文も変わらず、面だけが変わる。
   * 戻す経路は無いので Undo ではなく、メニュー側の確認で受けている。
   * 移した先の面へ着地させる — この面の一覧からは消えるので、残ると
   * 先頭のノートに倒れて「消えた」ように見える。
   */
  const promoteToCodex = async (item: NoteItem): Promise<void> => {
    shell.closePopovers();
    await settleWrites();
    await typedInvoke("promote_note_to_codex", { filename: item.filename });
    await refetchNotes();
    // Scrawl の origin チップも一覧から導出される。面が変わっても
    // 繋がりは残るので、向こうにも読み直させる
    shell.refreshData();
    navigate(noteRoute("codex", item.filename));
    shell.showToast(t().codex.promoted);
  };

  // ---- 削除 + Undo（5秒は tombstone、経過後に本削除）----
  const remove = async (item: NoteItem): Promise<void> => {
    // 隣を選ぶ前に編集を畳む。switchTo と同じ理屈だが、削除は詳細ペインを
    // 開かない(狭い端末では隣を開いたままにする)ので switchTo は通さない
    await settleEdit();
    // 隠す前に隣を決める。selected は一覧から消えた id を先頭へ倒すので、
    // 何もしないと削除のたびに最上段へ飛ばされる。隣なら目線は動かない。
    // detailOpen は触らない — 今まで通り、端末が狭ければ隣を開いたままにする
    const neighbor = neighborOf(visibleItems(), item.id);
    shell.closePopovers();
    batch(() => {
      setHidden((ids) => [...ids, item.id]);
      setSelectedId(neighbor);
    });

    const commit = setTimeout(() => {
      void (async () => {
        await typedInvoke("delete_note", { filename: item.filename });
        await refetchNotes();
        setHidden((ids) => ids.filter((id) => id !== item.id));
        // Scrawl の origin チップはノート一覧から導出される。Undo の
        // 猶予中に他のビューへ移られるとこの refetch は届かないので、版を
        // 上げて向こうの一覧も読み直させる
        shell.refreshData();
      })();
    }, UNDO_MS);

    shell.showToast(t().notes.deleted, () => {
      clearTimeout(commit);
      batch(() => {
        setHidden((ids) => ids.filter((id) => id !== item.id));
        // 取り消しは「消す前」へ戻す操作。隣に残したままだと、戻ったのに
        // 別のノートを見せられる
        setSelectedId(item.id);
      });
    });
  };

  return (
    <div class="workspace" classList={{ "workspace--detail": detailOpen() }}>
      <div class="list-pane">
        <div class="list-pane-head">
          <span class="list-pane-title">
            {MODE_LABELS[kind() === "codex" ? ROUTES.CODEX : ROUTES.NOTES]}
          </span>
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
              // テンプレは Note の入口。Codex の面では空の 1 本を作るだけ —
              // `create_from_template` は置き場を選べない
              if (newNotePointer === "mouse" && kind() === "note") {
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
            onPick={(template) => {
              void createFromTemplate(template);
            }}
            onManage={() => {
              shell.closePopovers();
              navigate(ROUTES.TEMPLATES);
            }}
          />
        </Show>

        {/* キーを受けるのは中の行(button)で、ここはそれを束ねているだけ。
            `.detail-body` と同じく、役割を名乗らない入れ物 */}
        <div class="list-scroll" ref={listScrollRef} role="presentation" onKeyDown={onListKeyDown}>
          <Show when={groups().length} fallback={<EmptyNotes kind={kind()} />}>
            <For each={groups()}>
              {(group) => (
                <>
                  <div class="list-group-label">{group.label}</div>
                  <For each={group.items}>
                    {(item) => (
                      <button
                        type="button"
                        class="list-row"
                        data-id={item.id}
                        classList={{
                          "list-row--selected": selected()?.id === item.id,
                          "list-row--codex": kind() === "codex",
                        }}
                        onClick={() => select(item as NoteItem)}
                      >
                        <span class="list-row-title">{itemTitle(item)}</span>
                        {/* 書けないノートはここで分かる。開いてから気づくのでは遅い */}
                        <Show when={(item as NoteItem).readOnly}>
                          <Icon name="lock-simple" size={12} title={t().notes.readOnly} />
                        </Show>
                        {/* Codex の行だけ、角折りのページに版の数。Note との違いの 1 つ目 */}
                        <Show when={kind() === "codex"}>
                          <PageMark
                            count={(item as NoteItem).versionCount ?? 0}
                            dirty={(item as NoteItem).dirty ?? false}
                          />
                        </Show>
                        <span class="list-row-stamp">{noteRowStamp(item as NoteItem, today)}</span>
                      </button>
                    )}
                  </For>
                </>
              )}
            </For>
          </Show>
        </div>
      </div>

      <div
        class="detail-pane"
        classList={{
          "detail-pane--map": mapOpen(),
          "detail-pane--spine": kind() === "codex",
          "detail-pane--history": kind() === "codex" && historyOpen(),
        }}
      >
        <Show when={selected()} fallback={<div class="detail-empty">{t().notes.noSelection}</div>}>
          {(item) => (
            <>
              {/* 題・記録・操作をひとまとまりに。本文と同じ段に置くので、
                  ノートについて知りたいことを離れた場所で探さなくていい */}
              <div class="detail-head">
                <div class="detail-title-row">
                  <button
                    type="button"
                    class="icon-button detail-back"
                    aria-label={t().notes.backToList}
                    onClick={() => {
                      void settleEdit();
                      setDetailOpen(false);
                    }}
                  >
                    <Icon name="arrow-left" size={18} />
                  </button>

                  {/* タイトルは本文先頭の H1 そのもの。ここで打ったものが
                      `# 見出し` として本文に書き戻る(`note-title.ts`)ので、
                      エディタとプレビューはタイトル行を持たない */}
                  <input
                    type="text"
                    class="note-title-input"
                    placeholder={t().notes.titlePlaceholder}
                    aria-label={t().notes.titlePlaceholder}
                    value={noteTitle()}
                    // 読み取り専用のノートは題も動かない。disabled にしないのは
                    // 読めなくなるから — 選んでコピーはできたままにする。
                    // 本文が届くまでも動かない(まだ前のノートの題が出ている)
                    readOnly={readOnly() || !loaded()}
                    onInput={(e) => editTitle(e.currentTarget.value)}
                    onChange={() => {
                      void commitTitle();
                    }}
                    onKeyDown={(e) => {
                      // 変換確定の Enter は IME のもの (#102)
                      if (e.key === "Enter" && !isImeComposing(e)) {
                        e.preventDefault();
                        focusBody();
                      }
                    }}
                  />

                  {/* ノート単位の操作はここ 1 つに畳む。どれも滅多に押さない */}
                  <button
                    type="button"
                    class="icon-button note-menu-button"
                    title={t().notes.actions}
                    aria-label={t().notes.actions}
                    aria-expanded={shell.popover() === "note-menu"}
                    data-key={shortcutLabel("noteActions")}
                    onClick={() => shell.togglePopover("note-menu")}
                  >
                    <Icon name="dots-three" size={17} />
                  </button>
                </div>

                {/* 作成日時・保存の様子・タグを 1 行で。ファイル名は同期や
                    ウィジェットが指す ID であって、人に見せるものではない */}
                <div class="detail-meta-line">
                  <span>{noteCreatedLabel(item())}</span>
                  {/* Codex は育ち具合を常に出す: 最新の版からの距離と、いつから何回刻んだか */}
                  <Show when={kind() === "codex" && versionStatus()}>
                    {(status) => (
                      <>
                        <span class="detail-meta-sep" aria-hidden="true">
                          ·
                        </span>
                        <span
                          class="detail-version-status"
                          classList={{ "detail-meta-tags": status().dirty }}
                        >
                          {versionStatusLabel(status())}
                        </span>
                        <Show when={cadence()}>
                          {(text) => (
                            <>
                              <span class="detail-meta-sep" aria-hidden="true">
                                ·
                              </span>
                              <span class="detail-version-cadence">{text()}</span>
                            </>
                          )}
                        </Show>
                      </>
                    )}
                  </Show>
                  <Show when={saveStatus() !== "idle"}>
                    <span class="detail-meta-sep" aria-hidden="true">
                      ·
                    </span>
                    <span class="detail-save-status" data-status={saveStatus()}>
                      <Show when={saveStatus() === "saving"}>
                        <Icon name="circle-notch" size={11} />
                      </Show>
                      <Show when={saveStatus() === "saved"}>
                        <Icon name="check" size={11} />
                      </Show>
                      {saveStatus() === "saving" ? t().common.saving : null}
                      {saveStatus() === "saved" ? t().common.saved : null}
                      {saveStatus() === "savedAt" ? t().notes.savedAt(savedAt()) : null}
                    </span>
                  </Show>
                  <Show when={item().tags.length > 0}>
                    <span class="detail-meta-sep" aria-hidden="true">
                      ·
                    </span>
                    <span class="detail-meta-tags">
                      {item()
                        .tags.map((tag) => `#${tag}`)
                        .join(" ")}
                    </span>
                  </Show>
                </div>

                <Show when={shell.popover() === "note-menu"}>
                  <NoteMenu
                    kind={kind()}
                    mapOpen={mapOpen()}
                    readOnly={readOnly()}
                    revertable={revertable()}
                    onToggleMap={() => {
                      void toggleMap(item());
                    }}
                    onToggleReadOnly={() => {
                      void toggleReadOnly(item());
                    }}
                    onRevert={() => {
                      void revertEdit(item());
                    }}
                    onInfo={() => shell.togglePopover("note-meta")}
                    onPromote={() => {
                      void promoteToCodex(item());
                    }}
                    onCommit={() => {
                      void commitVersion(item());
                    }}
                    onHistory={() => {
                      void openHistory();
                    }}
                    onDelete={() => {
                      void remove(item());
                    }}
                  />
                </Show>

                {/* 並べる幅が無いところでは、背骨を横に倒して題の下に置く */}
                <Show when={kind() === "codex" && historyOpen() && !spineWide()}>
                  <VersionSlider
                    rows={versionRows()}
                    selectedId={selectedVersionId()}
                    now={new Date()}
                    onSelect={setSelectedVersionId}
                    onCommit={() => {
                      void commitVersion(item());
                    }}
                  />
                </Show>
              </div>

              <Show when={shell.popover() === "note-meta"}>
                <NoteMetaPopover
                  filename={item().filename}
                  revertable={revertable()}
                  onRevert={() => {
                    void revertEdit(item());
                  }}
                  onSaved={async () => {
                    await refetchNotes();
                  }}
                  onClose={() => shell.closePopovers()}
                />
              </Show>

              <div
                class="detail-panes"
                classList={{ "detail-panes--map": mapOpen() && !historyOpen() }}
              >
                {/* 背骨。Codex の本文の左に常にあり、履歴を開くとここが伸びる。
                    Note には無い(違いの 2 つ目)。携帯の幅では CSS が畳む */}
                <Show when={kind() === "codex" && twoPane()}>
                  <VersionSpine
                    rows={versionRows()}
                    dirty={versionStatus()?.dirty ?? false}
                    bytesDelta={versionStatus()?.bytes_delta ?? 0}
                    open={historyOpen() && spineWide()}
                    selectedId={selectedVersionId()}
                    same={sameAsDraft()}
                    readOnly={readOnly()}
                    onOpen={() => {
                      void openHistory();
                    }}
                    onClose={closeHistory}
                    onSelect={setSelectedVersionId}
                    onRestore={(id) => {
                      void restoreVersion(item(), id);
                    }}
                    onCommit={() => {
                      void commitVersion(item());
                    }}
                  />
                </Show>
                {/* biome-ignore/eslint 対応: ここで拾うのは href の無い
                    ノートリンクだけ。書く操作はエディタ自身が受ける */}
                <div
                  class="detail-body"
                  data-view={historyOpen() ? "history" : noteView()}
                  ref={detailBodyRef}
                  role="presentation"
                  onClick={onBodyClick}
                >
                  {/* 履歴を開いているあいだ、本文は読み取り専用になり、選んだ版との
                      差が欄外の印になる。エディタは畳む — 開いたまま下に残すと、
                      戻した本文と古い文書が同時に在ることになる */}
                  <Show when={historyOpen()}>
                    <MarkdownPreview
                      source={marked()?.source ?? noteBody()}
                      marks={marked()?.marks ?? []}
                      noteTitles={noteTitles()}
                      glyphs={glyphs()}
                      exportStem={item().filename.replace(/\.md$/u, "")}
                      onError={(message) => shell.showToast(message)}
                    />
                  </Show>
                  <Show when={!historyOpen()}>
                    <Show
                      when={!readOnly()}
                      fallback={
                        <>
                          <MarkdownPreview
                            source={noteBody()}
                            noteTitles={noteTitles()}
                            glyphs={glyphs()}
                            exportStem={item().filename.replace(/\.md$/u, "")}
                            onError={(message) => shell.showToast(message)}
                          />
                          <Backlinks hits={backlinks() ?? []} onOpen={openBacklink} />
                        </>
                      }
                    >
                      {/* エディタは自分の文書を正とするので、本文が入れ替わったら
                        作り直す。差し込みはカーソルと IME ごと壊す。
                        本文が届くまでは立てない — 前のノートの本文で立てた
                        エディタに打った字は、隣のノートへ書かれる */}
                      <Show when={bodyVisible() && loaded() && bodyEpoch()} keyed>
                        <MilkdownEditor
                          placeholder={t().notes.bodyPlaceholder}
                          noteLinks={linkTargets}
                          glyphs={glyphs}
                          defaultValue={noteBody()}
                          onChange={(markdown) => {
                            if (!loaded()) {
                              return;
                            }
                            ensureSession();
                            setNoteBody(markdown);
                            scheduleSave();
                          }}
                          onEditorReady={setMarkdownEditor}
                        />
                      </Show>
                      <Backlinks hits={backlinks() ?? []} onOpen={openBacklink} />
                    </Show>
                  </Show>
                </div>

                {/* マップは本文を置き換えず、隣に並べる。1100px を切ると
                    並べる幅が無いので、そこだけ本文と入れ替わる(CSS 側) */}
                {/* 本文が丸ごと入れ替わったとき(`bodyEpoch`)は待たずに描き直す。
                    待たせると前のノートの図が 1 拍残る */}
                <Show when={mapOpen() && !historyOpen() && bodyEpoch()} keyed>
                  <NoteMap source={fullBody} />
                </Show>
              </div>

              {/* カードで送っているときの「閉じる」「この版に戻す」。背骨が
                  広がっているときは背骨の足元にある */}
              <Show when={kind() === "codex" && historyOpen() && !spineWide()}>
                <div class="history-actions">
                  <button type="button" class="button-secondary" onClick={closeHistory}>
                    {t().codex.close}
                  </button>
                  <button
                    type="button"
                    class="button-secondary"
                    disabled={readOnly() || selectedVersionId() === null}
                    onClick={() => {
                      const id = selectedVersionId();
                      if (id !== null) {
                        void restoreVersion(item(), id);
                      }
                    }}
                  >
                    <Icon name="arrow-counter-clockwise" size={14} />
                    {t().codex.restore}
                  </button>
                </div>
              </Show>
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
