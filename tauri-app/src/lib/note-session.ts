/**
 * 開いているノートの、ディスクと画面のあいだの調停。本文を読む・指紋を憶える・
 * 自動保存を予約する・断られたら譲る、までを 1 か所に集めたもの。画面
 * (`views/Workspace.tsx`)は「何を見せるか」だけを持ち、「いつ・どのノートに・
 * どの本文を書くか」はここが決める。
 *
 * 読みと書きを同じ場所に置いてあるのは、この 2 つが指紋(`revision`)で
 * 噛み合っているから。読んだときの指紋を添えて書き、合わなければ core が
 * 断る — 読みだけを画面側に残すと、指紋を渡す経路が画面を一周することになり、
 * 「どの本文を読んだときの指紋で書いたのか」が追えなくなる。
 *
 * ここに集めてあるもう 1 つの理由は、判断が全部「時間のずれ」の話だから。
 * 保存は 1 秒遅れて起き、IPC の往復のあいだに人は隣のノートへ移り、同じ
 * ノートを CLI や他の端末も書く。画面の中に散らしておくと、どの経路がどの
 * ずれを見ているのかが追えない — 打った字が黙って消えるのは、たいていその隙間。
 *
 * Solid には依存しない。必要なものは全部 `NoteSessionDeps` で受ける。
 */

import { beginEditSession, recordSaved, shouldSave, tryWriteBackup } from "./edit-backup";
import type { BackupStore, EditSession } from "./edit-backup";
import { isStaleSave } from "./commands";
import { t } from "./i18n";
import { refusalToast } from "./save-refusal";
import type { RefusedScreen } from "./save-refusal";
import { splitTitle } from "./note-title";
import type { NoteContent, NoteView } from "./note-view";

/** 自動保存を起こすまでの間。打鍵が止まってから書く。 */
const SAVE_DEBOUNCE_MS = 1000;

/** メタ行に出る保存の様子。 */
export type SaveStatus = "idle" | "saving" | "saved" | "savedAt";

/** 調停の相手。`items.ts` の `NoteItem` のうち、ここが見るぶんだけ。 */
export interface SaveTarget {
  /** 一覧の中での同一性。ファイル名と同じだが、意味が違うので分けてある。 */
  id: string;
  filename: string;
  /** 断られたときの言い分に出す題。 */
  title: string;
}

/**
 * 保存 1 回ぶんの単位。「どのノートに・何を・どのセッションで」を
 * 呼ばれた時点で固める。タイマーが起きる頃には別のノートが選ばれて
 * いることがあり、そのとき画面の本文を読むと隣のノートへ書いてしまう。
 */
export interface PendingSave {
  item: SaveTarget;
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

export interface NoteSessionDeps {
  /** いま選んでいるノート。読みも書きもこの相手に向かう。 */
  selected: () => SaveTarget | undefined;
  /** 画面の本文が、選んでいるノートのものとして届いているか。 */
  loaded: () => boolean;
  /** 画面に出ている本文。題を結合した、ファイルに書くぶんそのもの。 */
  body: () => string;
  /** 本文を外から入れ替えた回数。写しがまだ画面に続いているかを見る。 */
  bodyEpoch: () => number;
  /** 本文にカーソルが入っているか。書いている最中は本文を差し替えない。 */
  bodyHasFocus: () => boolean;
  /** 控えの置き場。テストはメモリ実装を差し込む。 */
  store: BackupStore;
  /** ディスクの本文とモードと指紋を読む。 */
  read: (filename: string) => Promise<NoteContent>;
  /** 本文を書く。返るのは書いた本文の指紋。断られたら throw。 */
  write: (filename: string, body: string, revision: string) => Promise<string>;
  /** 読めた本文を画面に置く。エディタごと作り直す唯一の道。 */
  showBody: (id: string, title: string, body: string, view: NoteView) => void;
  /** 一覧を読み直す。行に出る題は本文の先頭行から導かれる。 */
  refreshList: () => unknown;
  setStatus: (status: SaveStatus) => void;
  /** 画面に出ているノートの保存が着地した。見せ方は画面が決める。 */
  onSaved: () => void;
  showToast: (text: string) => void;
}

export interface NoteSession {
  /**
   * いま人が本文を書いている最中か。エディタは開きっぱなしなので、
   * 「編集モードに入っているか」では区別が付かない。まだディスクに無い
   * 打鍵があるか、本文にカーソルが入っているかで見る — どちらの場合も
   * 本文を差し替えるとカーソル・選択・IME ごと壊す(editor skill)。
   */
  isTyping: () => boolean;
  /**
   * ディスクから読み直して画面に出す。選択の切り替えと、外からの書き換えの後に。
   * `force` は「打った字はもう退避してあるので、書いている最中でも譲る」の合図。
   *
   * 返るのは「読み直しを実際に画面へ載せたか」。読めなかったぶんと、届く前に
   * 選択が移って見送ったぶんは `false` — 呼ぶ側が「読み直しました」と言う前に
   * 確かめられるように、載せたかどうかはここからしか分からない。
   */
  reload: (item: SaveTarget, force?: boolean) => Promise<boolean>;
  /** 書き換える直前の本文でセッションを開く。開いている間は開き直さない。 */
  ensure: () => void;
  /** 別のノートへ移る・ディスクの本文が入れ替わったときに畳む。 */
  drop: () => void;
  /** 控えを取り終えたセッションとして開き直す。「編集前に戻す」の着地点。 */
  reopenAt: (filename: string, body: string) => void;
  /** 画面に出ている本文を読んだときの指紋。 */
  revisionOf: (filename: string) => string | undefined;
  setRevision: (filename: string, revision: string) => void;
  forgetRevision: (filename: string) => void;
  /** 指したノートぶんの写し。`loaded` の判断を済ませた経路が使う。 */
  snapshotFor: (item: SaveTarget) => PendingSave;
  /** 打鍵のたびに呼ぶ。実際に走るのは最後の打鍵の写し。 */
  schedule: () => void;
  /** 予約を捨てて、いま書く。`pending` を省くとその場で写しを取る。 */
  flush: (pending?: PendingSave) => Promise<void>;
  /** 予約を捨てる。書かない。 */
  cancelPending: () => void;
  /** 保存が着地したぶんだけ一覧を読み直す。行に出る題が動いていなければ何もしない。 */
  refreshListIfStale: () => Promise<void>;
  /** 待っている保存を出しきってから離れる。選択を動かす手前で必ず通す道。 */
  settleEdit: () => Promise<void>;
  /** ファイルを動かす前の `settleEdit`。発火済みの書き込みの着地まで待つ。 */
  settleWrites: () => Promise<void>;
  /** 読んでから書くまでに外で書き換えられていた。譲って読み直す。 */
  yieldToOutsideEdit: (pending: PendingSave, error: unknown) => Promise<void>;
  /** 画面を閉じるとき。待っている保存は出しきる。 */
  dispose: () => void;
}

export function createNoteSession(deps: NoteSessionDeps): NoteSession {
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
   * Debounce only. An expired timer does not mean the write succeeded.
   */
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let timerFile: string | undefined;
  let draft: PendingSave | undefined;
  /** 保存は直列に流す。同じノートへの 2 本が同時に飛ぶと後の勝ちが決まらない。 */
  let saveChain: Promise<void> = Promise.resolve();
  /**
   * 保存の世代。外からの書き換えに譲って読み直すたびに、その Note だけ進める。
   * 譲るより前に `saveChain` に並んだ写しは、読み直した版を知らないまま
   * 順番が来る。そのまま書くと、いま画面に出ている相手の本文を古い draft で
   * 潰す — 読み直しで `revisions` が新しくなっているので core も止められない。
   * `session.lastSavedBody` を合わせるだけでは「同じ本文の写し」しか止まらない。
   */
  const saveGenerations = new Map<string, number>();
  const generationOf = (filename: string): number => saveGenerations.get(filename) ?? 0;
  let readGeneration = 0;
  let editGeneration = 0;
  /**
   * 一覧の行に出る題がディスクと食い違っているか。保存が着地するたびに立て、
   * 読み直したら下ろす。「待っている保存があるか」で代用すると、自動保存が
   * 先に着地していたときに読み直しが飛ばされ、行だけ古い題のまま残る。
   */
  let listStale = false;

  const isTyping = (): boolean =>
    Boolean(saveTimer) ||
    deps.bodyHasFocus() ||
    (draft !== undefined &&
      draft.item.filename === deps.selected()?.filename &&
      draft.bodyEpoch === deps.bodyEpoch() &&
      shouldSave(draft.session, deps.body()));

  const cancelPending = (): void => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    timerFile = undefined;
  };

  const drop = (): void => {
    sessionFile = null;
  };

  const reload = async (item: SaveTarget, force = false): Promise<boolean> => {
    const reading = ++readGeneration;
    const editing = editGeneration;
    try {
      const content = await deps.read(item.filename);
      // 一覧を素早くたどると、遅い読みが速い読みを追い越して届く。
      // いま選ばれているノートへの答えだけを画面に出す。読み始める前に
      // 確かめた「編集中でも保存待ちでもない」も、届いた時点でもう一度見る —
      // 応答を待つあいだにタップして書き始められる。
      // revision まで見送るのは、画面に出していない版で保存に行くと、
      // 読んでいない相手の本文の上に書けてしまうから
      if (
        reading !== readGeneration ||
        editing !== editGeneration ||
        deps.selected()?.id !== item.id ||
        (!force && isTyping())
      ) {
        return false;
      }
      revisions.set(item.filename, content.revision);
      // 本文とモードは対で出す。バラすと一瞬だけ違うモードで描かれる
      const titled = splitTitle(content.body);
      deps.showBody(item.id, titled.title, titled.body, content.view);
      drop();
      draft = undefined;
      return true;
    } catch {
      // 読めなかったことを本文の入れ替えにしない。空のエディタを立てると
      // 「空のノート」に見え、そこへ打った数文字がノート全体になる。
      // `loadedId` を進めないので、本文も題も書ける状態にならない
      if (reading === readGeneration && deps.selected()?.id === item.id && (force || !isTyping())) {
        deps.showToast(t().notes.loadFailed);
      }
      return false;
    }
  };

  const ensure = (): void => {
    const item = deps.selected();
    if (!item || sessionFile === item.filename) {
      return;
    }
    session = beginEditSession(deps.body());
    sessionFile = item.filename;
  };

  const reopenAt = (filename: string, body: string): void => {
    // 開き直さないと、次に題や本文を触ったときに新しいセッションが立ち上がり、
    // その最初の保存が復元直前の本文を控えに書いて、もう一度押しても戻れなくなる
    session = beginEditSession(body);
    session.committed = true;
    sessionFile = filename;
  };

  const snapshotFor = (item: SaveTarget): PendingSave => ({
    item,
    body: deps.body(),
    session,
    generation: generationOf(item.filename),
    bodyEpoch: deps.bodyEpoch(),
  });

  const snapshot = (): PendingSave | undefined => {
    const item = deps.selected();
    // 本文が届いていないノートには写しを取らない。画面にあるのは前のノート
    return item && deps.loaded() ? snapshotFor(item) : undefined;
  };

  const refreshListIfStale = async (): Promise<void> => {
    if (!listStale) {
      return;
    }
    listStale = false;
    await deps.refreshList();
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
    deps.bodyEpoch() === pending.bodyEpoch ? deps.body() : pending.body;

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
    if (deps.selected()?.id !== pending.item.id) {
      return "away";
    }
    return reloaded || deps.bodyEpoch() !== pending.bodyEpoch ? "reloaded" : "draft";
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
    const kept = tryWriteBackup(deps.store, pending.item.filename, typedBody(pending));
    saveGenerations.set(pending.item.filename, generationOf(pending.item.filename) + 1);
    if (timerFile === pending.item.filename) {
      cancelPending();
    }
    let reloaded = false;
    // A failed backup leaves the editor as the only copy of these keystrokes.
    if (kept && deps.selected()?.id === pending.item.id && deps.bodyEpoch() === pending.bodyEpoch) {
      reloaded = await reload(pending.item, true);
    }
    await deps.refreshList();
    deps.showToast(refusalToast(error, kept, pending.item.title, refusedScreen(pending, reloaded)));
  };

  const flush = (pending = snapshot()): Promise<void> => {
    const previous = saveChain;
    saveChain = (async () => {
      await previous;
      // 触っていない誤タップのセッションを書き込みに変えない。書いても
      // 内容が変わらないなら、ファイルの mtime を動かして同期を起こすだけ。
      // 読み直しをまたいだ写しも書かない(世代が置いていかれている)
      if (
        !pending ||
        pending.generation !== generationOf(pending.item.filename) ||
        !shouldSave(pending.session, pending.body)
      ) {
        return;
      }
      // 保存の様子はそのノートの持ち物。書き込みが遅い端末では、隣へ移った
      // あとに着地することがあり、そのまま出すと開いたばかりのノートが
      // 「保存しました」と言う。画面に出ているノートの保存のときだけ出す
      const shown = (): boolean => deps.selected()?.id === pending.item.id;
      // 指紋を持たないノートには書かない。`revision` 無しの保存は core の
      // 照合を素通りするので、読めていない本文の上に画面のぶんを丸ごと
      // 書いてしまう。読み直しが通れば指紋が入り、次の保存から書ける
      const expected = revisions.get(pending.item.filename);
      if (expected === undefined) {
        return;
      }
      if (shown()) {
        deps.setStatus("saving");
      }
      try {
        const revision = await deps.write(pending.item.filename, pending.body, expected);
        revisions.set(pending.item.filename, revision);
        recordSaved(deps.store, pending.item.filename, pending.session, pending.body);
        // 一覧はここでは読み直さない。1 秒おきの保存のたびに全ノートを
        // 読み直すのは低スペック端末に重く、編集中は一覧が見えてもいない。
        // 書く手が止まったときに 1 回だけ読み直す。
        listStale = true;
        if (shown()) {
          deps.onSaved();
        }
      } catch (error) {
        if (shown()) {
          deps.setStatus("idle");
        }
        if (isStaleSave(error)) {
          await yieldToOutsideEdit(pending, error);
        } else {
          // Even a transient I/O failure may be followed by navigation instead
          // of another keystroke. Keep the draft before the screen can leave.
          const kept = tryWriteBackup(deps.store, pending.item.filename, typedBody(pending));
          // ここは読み直しを走らせない。画面にあるのは打鍵の続きか、別のノート
          deps.showToast(
            refusalToast(error, kept, pending.item.title, refusedScreen(pending, false)),
          );
        }
      }
    })();
    return saveChain;
  };

  const schedule = (): void => {
    editGeneration += 1;
    // 打鍵ごとに取り直すので、実際に走るのは最後の打鍵の写し
    const pending = snapshot();
    draft = pending;
    cancelPending();
    timerFile = pending?.item.filename;
    saveTimer = setTimeout(() => {
      // 起きたタイマーは終わったタイマー。掃除しないと「保存待ちがある」が
      // 立ったままになり、フォーカス復帰の読み直しが二度と通らない
      saveTimer = undefined;
      timerFile = undefined;
      void flush(pending);
    }, SAVE_DEBOUNCE_MS);
  };

  /**
   * 待っている保存を出しきってから離れる。選択を動かす手前で必ず通す道。
   * 出しきらずに移ると本文が「次のノートの題 + 前のノートの本文」になり、
   * 次の保存がその混ぜ物を隣のノートへ書き込む。読み直しが `revisions` を
   * 更新済みなので Stale でも止まらない。
   * 何も保存していないなら一覧も読み直さない — 行に出る題は変わっていない。
   */
  const settleEdit = async (): Promise<void> => {
    // 次に書き始めるときは新しいセッション。戻る先が 1 段ずつ進む
    drop();
    if (saveTimer) {
      cancelPending();
      await flush();
    }
    // 行に出る題は本文の先頭行から導かれる。読み直さないと一覧だけ古い題のまま
    await refreshListIfStale();
  };

  const settleWrites = async (): Promise<void> => {
    await settleEdit();
    await saveChain;
  };

  const dispose = (): void => {
    if (saveTimer) {
      cancelPending();
      void flush();
    }
  };

  return {
    isTyping,
    reload,
    ensure,
    drop,
    reopenAt,
    revisionOf: (filename) => revisions.get(filename),
    setRevision: (filename, revision) => revisions.set(filename, revision),
    forgetRevision: (filename) => revisions.delete(filename),
    snapshotFor,
    schedule,
    flush,
    cancelPending,
    refreshListIfStale,
    settleEdit,
    settleWrites,
    yieldToOutsideEdit,
    dispose,
  };
}
