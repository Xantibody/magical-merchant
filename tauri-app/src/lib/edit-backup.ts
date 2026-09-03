/**
 * 編集セッションの保存判断と、端末ローカルの 1 段階バックアップ。
 *
 * 自動保存の世界での「誤タップ・誤編集」への保険。編集を始める前の本文を
 * この端末(localStorage)にだけ 1 枠残し、いつでも入れ替えで戻せるように
 * する。ファイルや frontmatter には書かない — 書けば同期に乗ってしまい、
 * どの端末の「戻る先」なのかが壊れる。
 */

/** localStorage の使う範囲だけ。テストではメモリ実装を差し込む。 */
export interface BackupStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export interface EditSession {
  /** セッション開始時点の本文。復元の「戻る先」になる。 */
  readonly preEditBody: string;
  /** 最後にファイルへ書いた本文。一致する限り保存はスキップする。 */
  lastSavedBody: string;
  /** バックアップはセッションにつき 1 回だけ書く。 */
  committed: boolean;
}

const KEY_PREFIX = "note-backup:";

export function readBackup(store: BackupStore, filename: string): string | null {
  try {
    return store.getItem(KEY_PREFIX + filename);
  } catch {
    return null;
  }
}

/** バックアップは善意の保険。容量超過などで書けなくても本流を落とさない。 */
export function writeBackup(store: BackupStore, filename: string, body: string): void {
  try {
    store.setItem(KEY_PREFIX + filename, body);
  } catch {
    // 書けなかったら戻る先が増えないだけ。保存自体は成功している
  }
}

export function beginEditSession(body: string): EditSession {
  return { preEditBody: body, lastSavedBody: body, committed: false };
}

/** 書いても内容が変わらない保存はしない。誤タップを書き込みに変えない。 */
export function shouldSave(session: EditSession, body: string): boolean {
  return body !== session.lastSavedBody;
}

/**
 * 保存が成功したら呼ぶ。内容が実際に変わった最初の保存でだけ、編集前の
 * 本文をバックアップに残す。変更のなかったセッションは何も書かない —
 * 1 枠しかない戻る先を「現在と同じ本文」で潰さないため。
 */
export function recordSaved(
  store: BackupStore,
  filename: string,
  session: EditSession,
  body: string,
): void {
  if (!session.committed && body !== session.preEditBody) {
    writeBackup(store, filename, session.preEditBody);
    session.committed = true;
  }
  session.lastSavedBody = body;
}
