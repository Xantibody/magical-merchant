import { describe, it, expect, onTestFinished, vi } from "vitest";
import { createNoteSession } from "./note-session";
import type { NoteSession, PendingSave, SaveStatus, SaveTarget } from "./note-session";
import type { BackupStore } from "./edit-backup";
import type { NoteContent } from "./note-view";
import { t } from "./i18n";

const NOTE: SaveTarget = {
  id: "20260919_101010.md",
  filename: "20260919_101010.md",
  title: "歩いた日",
};
const OTHER: SaveTarget = {
  id: "20260919_202020.md",
  filename: "20260919_202020.md",
  title: "読んだ本",
};

const refusal = (kind: string): unknown => ({ kind, message: kind });

/** 控えの置き場。書けない端末を作れるように失敗も差せる。 */
function memoryStore(broken = false): BackupStore & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      if (broken) {
        throw new Error("quota");
      }
      items.set(key, value);
    },
  };
}

interface Harness {
  session: NoteSession;
  /** 実際にディスクへ向かった書き込み。 */
  writes: { filename: string; body: string; revision: string }[];
  toasts: string[];
  statuses: SaveStatus[];
  /** 画面に載った本文。`showBody` の呼ばれたぶん。 */
  shown: { id: string; title: string; body: string }[];
  refreshes: number;
  saved: number;
  store: ReturnType<typeof memoryStore>;
  /** 画面の状態。テストが直に動かす。 */
  view: {
    selected: SaveTarget | undefined;
    loaded: boolean;
    body: string;
    bodyEpoch: number;
    focus: boolean;
  };
  /** 次の読みが返す本文。null なら読みが失敗する。 */
  disk: { content: NoteContent | null };
  /** 次の書き込みを断る理由。null なら書ける。 */
  refuse: { error: unknown };
}

function harness(options: { store?: ReturnType<typeof memoryStore> } = {}): Harness {
  // 1 秒の debounce を待たずに進める。片付けはテストごとに
  vi.useFakeTimers();
  onTestFinished(() => vi.useRealTimers());

  const store = options.store ?? memoryStore();
  const writes: Harness["writes"] = [];
  const toasts: string[] = [];
  const statuses: SaveStatus[] = [];
  const shown: Harness["shown"] = [];
  const view: Harness["view"] = {
    selected: NOTE,
    loaded: true,
    body: "# 歩いた日\n\n三丁目まで",
    bodyEpoch: 1,
    focus: false,
  };
  const disk: Harness["disk"] = {
    content: { body: "# 歩いた日\n\nディスクのぶん", view: "editor", revision: "r-disk" },
  };
  const refuse: Harness["refuse"] = { error: null };
  const counts = { refreshes: 0, saved: 0 };

  const session = createNoteSession({
    selected: () => view.selected,
    loaded: () => view.loaded,
    body: () => view.body,
    bodyEpoch: () => view.bodyEpoch,
    bodyHasFocus: () => view.focus,
    store,
    read: (filename) =>
      disk.content
        ? Promise.resolve(disk.content)
        : Promise.reject(new Error(`cannot read ${filename}`)),
    write: (filename, body, revision) => {
      if (refuse.error) {
        return Promise.reject(refuse.error);
      }
      writes.push({ filename, body, revision });
      return Promise.resolve(`r-${writes.length}`);
    },
    showBody: (id, title, body) => {
      shown.push({ id, title, body });
      // 本物の画面と同じように、載せたら世代が 1 つ進む
      view.bodyEpoch += 1;
      view.body = title ? `${title}\n\n${body}` : body;
    },
    refreshList: () => {
      counts.refreshes += 1;
    },
    setStatus: (status) => statuses.push(status),
    onSaved: () => {
      counts.saved += 1;
    },
    showToast: (text) => toasts.push(text),
  });

  return {
    session,
    writes,
    toasts,
    statuses,
    shown,
    store,
    view,
    disk,
    refuse,
    get refreshes() {
      return counts.refreshes;
    },
    get saved() {
      return counts.saved;
    },
  };
}

/** 1 文字打った状態にする。保存の入口はここから。 */
function keystroke(h: Harness, body: string): void {
  h.session.ensure();
  h.view.body = body;
  h.session.schedule();
}

/** 読み終えたノートに 1 文字打つ。指紋を持たないノートには保存が行かない。 */
function typed(h: Harness, body: string): void {
  h.session.setRevision(NOTE.filename, "r-read");
  keystroke(h, body);
}

describe("自動保存の予約", () => {
  it("writes once the typing pauses, with the revision it read", async () => {
    const h = harness();
    typed(h, "# 歩いた日\n\n四丁目まで");

    expect(h.writes).toStrictEqual([]);
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.writes).toStrictEqual([
      { filename: NOTE.filename, body: "# 歩いた日\n\n四丁目まで", revision: "r-read" },
    ]);
    expect(h.saved).toBe(1);
  });

  // 誤タップを書き込みに変えない。書いても中身が同じなら mtime だけが動く
  it("skips a save whose body never changed", async () => {
    const h = harness();
    h.session.setRevision(NOTE.filename, "r-read");
    h.session.ensure();
    h.session.schedule();
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.writes).toStrictEqual([]);
  });

  /**
   * 指紋が無いノートに書くと、core の照合を素通りして読めていない本文の上に
   * 画面のぶんを丸ごと書いてしまう
   */
  it("writes nothing to a note it has no fingerprint for", async () => {
    const h = harness();
    h.session.ensure();
    h.view.body = "打った";
    h.session.schedule();
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.writes).toStrictEqual([]);
  });

  // 本文が届いていないノートには写しを取らない。画面にあるのは前のノート
  it("takes no snapshot before the body has arrived", async () => {
    const h = harness();
    h.session.setRevision(NOTE.filename, "r-read");
    h.view.loaded = false;
    h.session.ensure();
    h.view.body = "前のノートの本文 + 打った字";
    h.session.schedule();
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.writes).toStrictEqual([]);
  });

  // 打鍵のたびに取り直すので、走るのは最後の 1 回だけ
  it("collapses a run of keystrokes into the last snapshot", async () => {
    const h = harness();
    typed(h, "一");
    await vi.advanceTimersByTimeAsync(400);
    typed(h, "一二");
    await vi.advanceTimersByTimeAsync(400);
    typed(h, "一二三");
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.writes.map((write) => write.body)).toStrictEqual(["一二三"]);
  });

  it("reports saving and hands the landing to the screen", async () => {
    const h = harness();
    typed(h, "打った");
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.statuses).toStrictEqual(["saving"]);
    expect(h.saved).toBe(1);
  });

  // 書き込みが遅い端末では、隣へ移ったあとに着地する
  it("keeps a late save's landing off the note opened after it", async () => {
    const h = harness();
    typed(h, "打った");
    h.view.selected = OTHER;
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.writes.map((write) => write.filename)).toStrictEqual([NOTE.filename]);
    expect(h.saved).toBe(0);
    expect(h.statuses).toStrictEqual([]);
  });
});

describe("isTyping", () => {
  it("is true while a save is still owed to the disk", async () => {
    const h = harness();
    expect(h.session.isTyping()).toBe(false);

    typed(h, "打った");
    expect(h.session.isTyping()).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.session.isTyping()).toBe(false);
  });

  it("is true while the caret sits in the body", () => {
    const h = harness();
    h.view.focus = true;

    expect(h.session.isTyping()).toBe(true);
  });
});

describe("読み直し", () => {
  it("puts the body on screen and remembers its fingerprint", async () => {
    const h = harness();

    await expect(h.session.reload(NOTE)).resolves.toBe(true);
    expect(h.shown).toStrictEqual([{ id: NOTE.id, title: "歩いた日", body: "ディスクのぶん" }]);
    expect(h.session.revisionOf(NOTE.filename)).toBe("r-disk");
  });

  // 本文の差し替えはカーソル・選択・IME ごと壊す
  it("leaves the body alone while it is being written", async () => {
    const h = harness();
    h.view.focus = true;

    await expect(h.session.reload(NOTE)).resolves.toBe(false);
    expect(h.shown).toStrictEqual([]);
    expect(h.session.revisionOf(NOTE.filename)).toBeUndefined();
  });

  it("yields anyway once the draft has been put somewhere safe", async () => {
    const h = harness();
    h.view.focus = true;

    await expect(h.session.reload(NOTE, true)).resolves.toBe(true);
    expect(h.shown).toHaveLength(1);
  });

  // 一覧を素早くたどると、遅い読みが速い読みを追い越して届く
  it("drops an answer for a note that is no longer selected", async () => {
    const h = harness();
    const reloading = h.session.reload(NOTE);
    h.view.selected = OTHER;

    await expect(reloading).resolves.toBe(false);
    expect(h.shown).toStrictEqual([]);
    expect(h.session.revisionOf(NOTE.filename)).toBeUndefined();
  });

  // 読めなかったことを本文の入れ替えにしない。空のノートに見せる害が大きい
  it("says so instead of emptying the body when the read fails", async () => {
    const h = harness();
    h.disk.content = null;

    await expect(h.session.reload(NOTE)).resolves.toBe(false);
    expect(h.shown).toStrictEqual([]);
    expect(h.toasts).toStrictEqual([t().notes.loadFailed]);
  });
});

describe("外からの書き換えに譲る", () => {
  const stale = refusal("stale");

  it("backs up the draft, reloads the disk body and names what happened", async () => {
    const h = harness();
    typed(h, "打った");
    h.refuse.error = stale;
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.store.items.get(`note-backup:${NOTE.filename}`)).toBe("打った");
    expect(h.shown).toHaveLength(1);
    expect(h.toasts).toStrictEqual([t().notes.editedElsewhere]);
  });

  /**
   * 退避するのは飛んでいった写しではなく、いま画面にあるぶん。IPC の往復の
   * あいだに打った字は、まだファイルにも控えにも無い
   */
  it("keeps the keystrokes that landed during the round trip", async () => {
    const h = harness();
    typed(h, "打った");
    h.refuse.error = stale;
    const flushing = vi.advanceTimersByTimeAsync(1000);
    h.view.body = "打った、さらに打った";
    await flushing;

    expect(h.store.items.get(`note-backup:${NOTE.filename}`)).toBe("打った、さらに打った");
  });

  // 画面の本文が入れ替わっていれば、退避するのは写しのほう
  it("backs up the snapshot once the screen body has been replaced", async () => {
    const h = harness();
    typed(h, "打った");
    h.refuse.error = stale;
    const flushing = vi.advanceTimersByTimeAsync(1000);
    h.view.bodyEpoch += 1;
    h.view.body = "別の読み込みで載ったぶん";
    await flushing;

    expect(h.store.items.get(`note-backup:${NOTE.filename}`)).toBe("打った");
  });

  // 往復のあいだに隣へ移っていれば、画面にディスクの本文を流し込めない
  it("does not reload into a note the screen has left", async () => {
    const h = harness();
    typed(h, "打った");
    h.refuse.error = stale;
    const flushing = vi.advanceTimersByTimeAsync(1000);
    h.view.selected = OTHER;
    await flushing;

    expect(h.shown).toStrictEqual([]);
    expect(h.toasts).toStrictEqual([t().notes.editedElsewhereAway(NOTE.title)]);
  });

  // 控えが残らなかったのに「戻す」で呼び出せると言うと、人は信じて閉じる
  it("promises no Revert when the backup cannot be written", async () => {
    const h = harness({ store: memoryStore(true) });
    typed(h, "打った");
    h.refuse.error = stale;
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.toasts).toStrictEqual([t().notes.staleNotKept]);
  });

  /**
   * 譲るより前に並んだ写しは、読み直した版を知らないまま順番が来る。そのまま
   * 書くと画面に出ている相手の本文を古い draft で潰す — 指紋は新しいので
   * core も止められない
   */
  it("drops a save that was queued before the yield", async () => {
    const h = harness();
    typed(h, "打った");
    const queued = h.session.snapshotFor(NOTE);
    h.refuse.error = stale;
    await vi.advanceTimersByTimeAsync(1000);
    h.refuse.error = null;

    await h.session.flush(queued);

    expect(h.writes).toStrictEqual([]);
  });
});

describe("読み直しでは直らない拒否", () => {
  it("backs up the draft and does not reload", async () => {
    const h = harness();
    typed(h, "打った");
    h.refuse.error = refusal("broken");
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.store.items.get(`note-backup:${NOTE.filename}`)).toBe("打った");
    expect(h.shown).toStrictEqual([]);
    expect(h.toasts).toStrictEqual([t().notes.brokenMeta]);
    expect(h.statuses).toStrictEqual(["saving", "idle"]);
  });

  // 名前の付かない失敗は退避もしない。次の打鍵の保存にまだ望みがある
  it("leaves an unnamed failure to the next keystroke", async () => {
    const h = harness();
    typed(h, "打った");
    h.refuse.error = new Error("network");
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.store.items.size).toBe(0);
    expect(h.toasts).toStrictEqual([]);
  });
});

describe("離れる手前", () => {
  it("flushes the pending save and refreshes the list once", async () => {
    const h = harness();
    typed(h, "打った");

    await h.session.settleEdit();

    expect(h.writes.map((write) => write.body)).toStrictEqual(["打った"]);
    expect(h.refreshes).toBe(1);
  });

  // 何も保存していないなら、行に出る題も変わっていない
  it("does not refresh the list when nothing was written", async () => {
    const h = harness();

    await h.session.settleEdit();

    expect(h.refreshes).toBe(0);
  });

  // 自動保存が先に着地していても、行だけ古い題のまま残してはいけない
  it("refreshes the list after an autosave has already landed", async () => {
    const h = harness();
    typed(h, "打った");
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.refreshes).toBe(0);

    await h.session.settleEdit();

    expect(h.refreshes).toBe(1);
  });

  // rename の後に着地する書き込みは移動前の path に向かう
  it("waits for a write that is still in flight", async () => {
    const h = harness();
    typed(h, "打った");
    const inFlight = h.session.flush();

    await h.session.settleWrites();

    await expect(inFlight).resolves.toBeUndefined();
    expect(h.writes).toHaveLength(1);
  });
});

describe("編集セッション", () => {
  // 1 枠しかない戻る先を、編集前ではない本文で潰さない
  it("keeps the pre-edit body as the one step back across several saves", async () => {
    const h = harness();
    typed(h, "一");
    await vi.advanceTimersByTimeAsync(1000);
    typed(h, "一二");
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.store.items.get(`note-backup:${NOTE.filename}`)).toBe("# 歩いた日\n\n三丁目まで");
  });

  // 別のノートへ移ったら畳む。戻る先が前のノートのままだと他人の控えを潰す
  it("opens a new session for the next note after a drop", async () => {
    const h = harness();
    h.session.setRevision(NOTE.filename, "r-read");
    h.session.ensure();
    h.session.drop();
    h.view.body = "畳んだあとの本文";
    h.session.ensure();
    h.view.body = "そこから打った";
    h.session.schedule();
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.store.items.get(`note-backup:${NOTE.filename}`)).toBe("畳んだあとの本文");
  });

  // 控えを取り終えたセッションとして開き直さないと、もう一度押しても戻れない
  it("does not overwrite the backup it just handed out", async () => {
    const h = harness();
    h.store.items.set(`note-backup:${NOTE.filename}`, "戻す前");
    h.session.setRevision(NOTE.filename, "r-read");
    h.session.reopenAt(NOTE.filename, "戻した本文");
    h.view.body = "戻した本文、から打った";
    h.session.schedule();
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.store.items.get(`note-backup:${NOTE.filename}`)).toBe("戻す前");
  });
});

describe("指紋", () => {
  it("forgets the fingerprint so the next save is refused instead of overwriting", () => {
    const h = harness();
    h.session.setRevision(NOTE.filename, "r-read");

    h.session.forgetRevision(NOTE.filename);

    expect(h.session.revisionOf(NOTE.filename)).toBeUndefined();
  });

  it("carries the revision the write returned into the next save", async () => {
    const h = harness();
    typed(h, "一");
    await vi.advanceTimersByTimeAsync(1000);
    // 2 打目は読み直していない。添えるのは 1 打目の書き込みが返した指紋
    keystroke(h, "一二");
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.writes.map((write) => write.revision)).toStrictEqual(["r-read", "r-1"]);
  });
});

describe("画面を閉じるとき", () => {
  it("still writes what was typed", async () => {
    const h = harness();
    typed(h, "打った");

    h.session.dispose();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.writes.map((write) => write.body)).toStrictEqual(["打った"]);
  });

  it("writes nothing when the disk is already up to date", async () => {
    const h = harness();

    h.session.dispose();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.writes).toStrictEqual([]);
  });
});

describe("snapshotFor", () => {
  // 「戻す」の拒否経路は、画面の判断を済ませてから写しを取る
  it("snapshots a note the screen has already vouched for", () => {
    const h = harness();
    h.view.body = "いまの本文";

    const pending: PendingSave = h.session.snapshotFor(NOTE);

    expect(pending.item).toBe(NOTE);
    expect(pending.body).toBe("いまの本文");
    expect(pending.bodyEpoch).toBe(h.view.bodyEpoch);
  });
});
