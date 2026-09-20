/**
 * 画面に出る言葉。日本語と英語だけを持つ。
 *
 * ライブラリは入れていない。必要なのは「表を 2 つ持って、片方を返す」
 * ことだけで、複数形の規則も日付書式の交渉も要らない — 数の入る文は
 * 関数にしてある。テーマ(`theme.ts`)と同じく、選択は localStorage に
 * 残し、system は端末の設定に従う。
 *
 * `t()` は signal を読む。JSX や createMemo の中から呼べば、言語を
 * 切り替えた瞬間に描き直される — 文字列を配る関数(`day-labels.ts` など)を
 * 経由していても追跡は切れない。
 */

import { createSignal } from "solid-js";
import type { SyncIssue } from "./sync-status";

export type Locale = "ja" | "en";

/**
 * 版どうしのバイト差。`+1.2 KB` / `−340 B` / `±0`。単位はどちらの言語でも
 * 同じ綴りなので、表を 2 つ持たず 1 つの関数を両方から指す。
 */
function sizeDelta(bytes: number): string {
  if (bytes === 0) {
    return "±0";
  }
  const sign = bytes > 0 ? "+" : "−";
  const size = Math.abs(bytes);
  return size < 1024 ? `${sign}${size} B` : `${sign}${(size / 1024).toFixed(1)} KB`;
}

/** 大きさそのもの。いちばん古い版は差ではなくこれを出す。`820 B` / `1.1 KB`。 */
function sizeOf(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** 「N か月で M 回刻んだ」の期間。月が満ちていなければ日で。 */
interface Span {
  months: number;
  days: number;
}
/** 設定に残す値。`system` は端末の言語に従う。 */
export type LocalePreference = Locale | "system";

const ja = {
  common: {
    save: "保存",
    saving: "保存中…",
    saved: "保存しました",
    delete: "削除",
    cancel: "キャンセル",
    back: "戻る",
    close: "閉じる",
    undo: "元に戻す",
    all: "すべて",
    tags: "タグ",
  },
  header: {
    searchPlaceholder: "検索・コマンド…",
    search: "検索",
    jumpToDate: "日付ジャンプ",
    sync: "同期",
    settings: "Settings",
  },
  rail: {
    label: "面の切り替えと全体の操作",
  },
  theme: {
    system: "システム",
    light: "ライト",
    dark: "ダーク",
  },
  hints: {
    pill: (modifier: string) => `${modifier} を離すと消える · ? で一覧`,
  },
  scrawl: {
    promote: "Note にする",
    unlink: (title: string) => `「${title}」との関係を解除`,
    unlinked: "Note との関係を解除しました",
    emptyToday: "今日はまだ何も記録していません。",
    emptyHint: "下の入力欄に書くと、時刻とともにここに並びます。",
    deleted: (count: number) => `${count}件のエントリを削除しました`,
    digestTitle: "今週",
    digestClose: "今週は閉じる",
    digestSummary: (days: number, count: number) => `${days}日で${count}件`,
    lastYear: "1年前の今日",
    lastYearOpen: "1年前の今日の記録を見る",
    selectHint: "消すエントリを選んでください",
    select: "選択",
    entryCount: (count: number) => `${count}件`,
    bulkDelete: "まとめて削除",
    selectedCount: (count: number) => `${count}件選択中`,
    selectionCleared: "一覧を読み直したので選択を解除しました",
    deleteCount: (count: number) => `削除 (${count}件)`,
    confirmDelete: (count: number) => `${count}件のエントリを削除します。よろしいですか？`,
    confirmDeleteYes: "削除する",
  },
  capture: {
    placeholder: "いま何を記録する？",
    suggestLabel: "タグ候補",
    newTag: (draft: string) => `+「#${draft}」を新規タグとして確定`,
  },
  browse: {
    title: "絞る",
    kind: "種類",
    period: "期間",
    thisMonth: "今月",
    thisWeek: "今週",
    clear: "絞り込みを外す",
    newestFirst: "新しい順",
    count: (count: number) => `${count}件`,
    empty: "この組み合わせの記録はありません",
    open: "開く",
    toDay: "その日へ",
    /** 1 行だけの記録。題がそのまま全文なので、下に出す本文が無い */
    noBody: "(本文なし — 1 行の記録)",
  },
  notes: {
    empty: "Note がありません",
    emptyHint: "新規から始めると、ここに並びます。",
    new: "新規",
    pinList: (key: string) => `常設 ${key}`,
    unpinList: (key: string) => `常設をやめる ${key}`,
    listHint: (key: string) => `${key} で常設 · 離れると畳む`,
    listPinnedHint: (key: string) => `${key} で畳む`,
    noSelection: "項目がありません",
    backToList: "一覧に戻る",
    info: "Note 情報",
    readOnly: "読み取り専用",
    actions: "この Note の操作",
    layMap: "マップを並べる",
    hideMap: "マップを閉じる",
    makeReadOnly: "読み取り専用にする",
    makeEditable: "編集できるようにする",
    revert: "編集前に戻す",
    savedAt: (time: string) => `${time} に保存`,
    titlePlaceholder: "タイトル",
    bodyPlaceholder: "Note を書く…",
    backlinks: (count: number) => `リンクされている記録 (${count})`,
    untitled: "(空の Note)",
    deleted: "Note を削除しました",
    reverted: "編集前の内容に戻しました",
    revertFailed: "戻せませんでした",
    editedElsewhere:
      "別の場所で書き換えられたので読み直しました。入力した本文は「戻す」で呼び出せます",
    /**
     * 譲ったのに読み直しが画面に載らなかったとき(読めなかった・届く前に
     * 打ち始めた)。画面にあるのはまだ入力した本文なので、「読み直しました」
     * と言うと、人はディスクのぶんを見ているつもりで写すのをやめる。
     */
    staleNotReloaded:
      "別の場所で書き換えられていたので保存できませんでした。ディスクの本文は読み直せず、画面にあるのは入力した本文のままです。この端末に控えましたが、別の場所へも写してください",
    brokenMeta:
      "この Note の先頭の記録が読めないので保存できません。入力した本文はこの端末に控えました。開き直せば「戻す」で画面に出せます",
    /**
     * ファイルそのものが文字として読めない。壊れているのは先頭の記録ではなく
     * 中身なので `brokenMeta` とは言い分を分ける — 開き直しても `read_note` が
     * 同じ理由で断られ、「戻す」で控えを画面に出す道が無い。
     */
    notTextNote:
      "この Note のファイルは文字として読めないので保存できません。入力した本文はこの端末に控えましたが、開き直しても読めないので、画面にあるうちに別の場所へ写してください",
    /** 無い Note は行ごと消えるので、「戻す」で呼び出せるとは言えない。 */
    missingNote:
      "この Note はもう在りません。保存できないので、入力した本文は画面にあるうちに別の場所へ写してください",
    shownFromBackup:
      "この端末に控えた本文を画面に出しました。この Note のディスクには書けないので、別の場所へ写してください",
    saveNotKept:
      "保存できず、この端末にも控えを残せませんでした。閉じると入力した本文は失われます。別の場所へ写してください",
    /**
     * Stale で控えも残せなかったとき。画面の本文はディスクのぶんに入れ替わって
     * いるので、「画面にあるうちに写して」と言っても写す相手がもう無い。
     */
    staleNotKept:
      "別の場所で書き換えられていたので保存できず、この端末にも控えを残せませんでした。入力した本文は失われました",
    /**
     * 断られた Note が画面に出ていないときの言い分。画面にあるのは別の Note の
     * 本文なので、「画面にあるうちに写して」は届かない。どの Note かを名乗り、
     * 控えの在り処と、いま取り出せるかどうかだけを言う。
     */
    editedElsewhereAway: (title: string) =>
      `「${title}」は別の場所で書き換えられていたので保存できませんでした。入力した本文はこの端末に控えました。「${title}」を開き直して「戻す」を押せば画面に出せます`,
    missingNoteAway: (title: string) =>
      `「${title}」はもう在りません。入力した本文はこの端末に控えましたが、消えた Note を開く道が無いので、今は画面に出せません`,
    brokenMetaAway: (title: string) =>
      `「${title}」は先頭の記録が読めないので保存できません。入力した本文はこの端末に控えました。開き直して「戻す」で画面に出せます`,
    notTextNoteAway: (title: string) =>
      `「${title}」のファイルは文字として読めないので保存できません。入力した本文はこの端末に控えましたが、読めない Note を開く道が無いので、今は画面に出せません`,
    saveNotKeptAway: (title: string) =>
      `「${title}」は保存できず、この端末にも控えを残せませんでした。入力した本文は失われました`,
    loadFailed: "この Note を読めませんでした。書き換えないよう、本文は開いていません",
  },
  codex: {
    empty: "育てる文書がまだありません",
    emptyHint: "Note の「…」から Codex にするか、新規から始めます。",
    promote: "Codex にする",
    /** 「Codex にする」の確認。何が増えるかを先に言い、戻れないことは最後に。 */
    promoteBody1:
      "書き足し続ける文書になります。区切りごとに版を刻み、前の版からどれだけ変わったかを見返せます。",
    promoteBody2: "Codex タブへ移ります。ID とリンクはそのまま。",
    promoteBody2Strong: "Note には戻せません。",
    promoteYes: "Codex にする",
    promoted: "Codex にしました",
    commit: "版を刻む",
    committed: (n: number) => `版 ${n} を刻みました`,
    commitFailed: "刻めませんでした",
    history: "履歴",
    draft: "下書き",
    now: "いま",
    restore: "この版に戻す",
    restored: "この版に戻しました。戻す前の下書きは履歴にあります",
    /**
     * 戻す書き込みは通ったが、そのあとの読み直しが画面に届かなかった。戻ったとは
     * 言えない — 画面に出ているのは戻す前の本文なので、開き直す一手まで言う。
     */
    restoredNotShown:
      "この版に戻しましたが、戻した本文を画面に出せませんでした。開き直してください",
    restoreFailed: "戻せませんでした",
    same: "同じ内容です",
    sameShort: "同じ内容",
    noVersions: "版なし",
    noVersionsHint: "まだ版がありません。いまの本文が最初の版になります。",
    close: "閉じる",
    /** 「版 4」。背骨の行・メタ行・一覧の記号の説明。 */
    versionN: (n: number) => `版 ${n}`,
    /** 「版 4 から +312 B」。最新の版からの距離。 */
    deltaFromLatest: (n: number, delta: number) => `版 ${n} から ${sizeDelta(delta)}`,
    /** 「9 か月で 4 回刻んだ」。最初の版からの経過と版の数。 */
    cadence: (count: number, span: Span): string => {
      if (span.months >= 1) {
        return `${span.months} か月で ${count} 回刻んだ`;
      }
      return span.days >= 1 ? `${span.days} 日で ${count} 回刻んだ` : `今日 ${count} 回刻んだ`;
    },
    /** 「7 日ぶり」。刻んだ直後のトースト。 */
    sinceDays: (days: number) => `${days} 日ぶり`,
    /** 一覧の角折りページの説明。 */
    pageMark: (count: number, dirty: boolean): string => {
      if (count === 0) {
        return "版なし";
      }
      return dirty ? `版 ${count} · 変更あり` : `版 ${count}`;
    },
    /** 横向きの背骨の左端。最初の版の月。 */
    monthOf: (month: number) => `${month}月`,
    sizeDelta,
    sizeOf,
    beforeRestore: "戻す前",
  },
  templates: {
    title: "テンプレート",
    manage: "テンプレートを管理",
    manageLink: "テンプレートを管理…",
    manageHint: "Note を作るときのテンプレートの作成・編集",
    fromTemplate: "テンプレートから",
    emptyNote: "空の Note",
    newNote: "新規 Note",
    new: "新規",
    empty: "テンプレートがありません",
    emptyHint: "新規から作ると、ここに並びます。",
    noSelection: "テンプレートを選んでください",
    namePlaceholder: "テンプレート名",
    titlePlaceholder: "タイトル",
    bodyPlaceholder: "テンプレートの本文…",
    autoTags: "自動タグ",
    addTag: "タグを追加",
    removeTag: (tag: string) => `タグ ${tag} を外す`,
    insertVariable: "変数を挿入",
    allVariables: "変数の一覧",
    varDate: "日付",
    varTime: "時刻",
    varWeekday: "曜日",
    varPrev: "前回の Note",
    todayPreview: "今日作ると",
    nameTaken: "同じ名前のテンプレートがあります",
    fileHint: "テンプレは templates/*.md の素の Markdown ファイル。同期にもそのまま乗る",
    deleted: "テンプレートを削除しました",
    unsaved: "未保存",
    discarded: "保存していない変更を破棄しました",
    saveFailed: "テンプレートを保存できませんでした",
    createFailed: "テンプレートから Note を作れませんでした",
    reused: (name: string) => `今日の「${name}」を開きました`,
    count: (count: number) => `${count}件`,
    backToSettings: "設定に戻る",
    backToList: "一覧に戻る",
    untitled: "(名前なし)",
  },
  meta: {
    unreadable: "メタデータを読み取れません",
    createdAt: "作成日時",
    updatedAt: "更新日時",
    removeTag: (tag: string) => `タグ ${tag} を外す`,
    addTag: "タグを追加",
    tagsHint: "作成時の記録。本文の #タグ は本文側で編集",
    context: "記録時の環境",
    backup: "この端末のバックアップ",
    revert: "編集前に戻す",
    revertHint: "直前の編集で上書きした本文と入れ替える。もう一度押すと戻る",
    saveFailed: "保存できませんでした",
    os: "OS",
    battery: "バッテリー",
    charging: "充電中",
    network: "ネットワーク",
    hostname: "ホスト名",
    location: "位置",
    locale: "ロケール",
    source: "書いたツール",
    sourceApp: "アプリ",
    sourceCli: "CLI",
    sourceMcp: "MCP",
    sourceWidget: "ウィジェット",
    sourceImport: "取り込み",
    wifi: "Wi-Fi",
    ethernet: "有線",
    mobile: "モバイル回線",
    offline: "オフライン",
  },
  sync: {
    synced: "すべて同期済み",
    syncing: "同期中…",
    notSyncing: "同期していません",
    failed: "同期に失敗しました",
    localOnly:
      "書いたものはこの端末の中だけに残ります。他の端末と揃えたいときだけ設定してください。",
    lastSync: (when: string) => `最終同期 ${when}`,
    autoSync: "保存時に自動同期",
    retry: "再試行",
    now: "今すぐ同期",
    openSettings: "設定を開く",
    notConfigured: "同期は未設定です",
    notSignedIn: "ログインしていません",
    configCorrupt: "同期設定のファイルが壊れています。上書きしないよう保存を止めました",
    justNow: "たった今",
    minutesAgo: (minutes: number) => `${minutes}分前`,
    hoursAgo: (hours: number) => `${hours}時間前`,
    daysAgo: (days: number) => `${days}日前`,
    // 1 回の同期が終わったあとの知らせ。core は kind と材料だけを返すので、
    // 文にするのはここ (`sync-status.ts` の describeSyncResult)
    result: {
      upToDate: "すべて同期済み",
      synced: (parts: string) => `同期しました ${parts}`,
      conflictsSaved: (count: number) => `競合${count}件を控えに保存しました`,
      failed: (count: number, first: string) => `${count} 件が失敗 — ${first}`,
      issue: (issue: SyncIssue) => {
        switch (issue.kind) {
          case "unsafe_key": {
            return `${issue.key}: 安全でない名前なので送りませんでした`;
          }
          case "missing_local_file": {
            return `${issue.key}: 送る直前に見つかりませんでした`;
          }
          case "read_failed": {
            return `${issue.key}: 読めませんでした (${issue.detail})`;
          }
          case "write_failed": {
            return `${issue.key}: 書けませんでした (${issue.detail})`;
          }
          case "decode_failed": {
            return `${issue.key}: 受け取った中身を戻せませんでした (${issue.detail})`;
          }
          case "delete_failed": {
            return `${issue.key}: 消せませんでした (${issue.detail})`;
          }
          case "delete_skipped_changed": {
            return `${issue.key}: 同期中に書き換わったので消さずに残しました`;
          }
        }
      },
    },
  },
  settings: {
    title: "設定",
    notSet: "未設定",
    signedIn: "ログイン済み",
    notSignedIn: "未ログイン",
    signInGoogle: "Google でログイン",
    signOut: "ログアウト",
    signInHint: "ログインするには、先に Workers URL を保存してください。",
    signedInMessage: "ログインしました",
    signInFailed: (reason: string) => `ログインに失敗しました: ${reason}`,
    saveFailed: (reason: string) => `保存できませんでした: ${reason}`,
    continueSignIn: "ログインを続けてください…",
    signedOutMessage: "ログアウトしました",
    signOutFailed: (reason: string) => `ログアウトできませんでした: ${reason}`,
    theme: "テーマ",
    language: "言語",
    languageSystem: "システム",
    languageJa: "日本語",
    languageEn: "English",
    startFullscreen: "起動時に全画面",
    startFullscreenHint: "次回の起動から反映されます",
    glyphs: "特殊文字",
    glyphsHint:
      "画像を登録すると、本文に :名前: と書いた場所にその画像が出ます。PNG か SVG、256 KB まで。",
    glyphsEmpty: "まだ登録がありません",
    addGlyph: "画像を追加",
    addGlyphsFolder: "フォルダから追加",
    glyphsFolderHint:
      "フォルダを選ぶと、中の PNG と SVG をファイル名の名前で登録します。同じ名前は上書きされます。data/glyphs/ に直接置いたファイルも読み込まれます。",
    glyphsImported: (saved: number, skipped: number) =>
      skipped > 0 ? `${saved} 件を登録(${skipped} 件はスキップ)` : `${saved} 件を登録しました`,
    glyphName: "名前",
    glyphNameHint: "小文字の英数字と _ + - だけ、32 文字まで",
    glyphUnsupported: "PNG か SVG の画像を選んでください",
    deleteGlyph: (name: string) => `:${name}: を削除`,
    glyphDeleted: "特殊文字を削除しました",
    glyphSaved: (name: string) => `:${name}: を登録しました`,
    glyphSaveFailed: (reason: string) => `登録できませんでした: ${reason}`,
    version: "バージョン",
  },
  palette: {
    dialogLabel: "検索・コマンド",
    commands: "コマンド",
    dates: "日付",
    recentNotes: "最近の Note",
    hits: "Note と Scrawl のエントリ",
    empty: "一致するものがありません",
    count: (count: number) => `${count}件`,
    newNote: "新規 Note",
    openScrawl: "Scrawl を開く",
    openNotes: "Note を開く",
    openCodex: "Codex を開く",
    openBrowse: "タグで絞る",
    openSettings: "設定を開く",
    scopeTag: (tag: string) => `#${tag} で絞り込み`,
    removeScope: "絞り込みを外す",
    // 引数は「#a #b」の形に揃えた範囲の文字(scopeLabel)。タグが幾つでも一文で済む
    emptyScoped: (scope: string) => `${scope} の中に一致するものがありません`,
  },
  editor: {
    copyCode: "コードをコピー",
    language: "言語",
    diagramFailed: "図を描画できません",
    exitBlock: "ブロックから抜ける",
    deleteBlock: "ブロックを削除",
    bulletList: "箇条書き",
    orderedList: "番号付きリスト",
    taskList: "チェックリスト",
    outdent: "インデントを戻す",
    indent: "インデント",
    codeBlock: "コードブロック",
    horizontalRule: "区切り線",
  },
  preview: {
    zoom: "拡大",
    zoomIn: "大きく",
    zoomOut: "小さく",
    fit: "全体表示",
    zoomHint: "ホイールでズーム / ドラッグで移動 / Esc で閉じる",
    saveSvg: "SVG で保存",
    savePng: "PNG で保存",
    exportFailed: "図を保存できませんでした",
  },
  firstRun: {
    title: "同期はあとからでも設定できます",
    body: "設定しなければ、書いたものはこの端末の中だけに残ります。それで困らないなら、このまま使い始めて構いません。",
    hint: "複数の端末で同じ記録を見たくなったら、Workers の URL をここか設定画面で入れてください。",
    connect: "接続",
    later: "あとで",
  },
  calendar: {
    prevMonth: "前の月",
    nextMonth: "次の月",
    /** 週の始まりは月曜。曜日の見出しは 1 文字ぶんの幅しかない */
    weekdays: ["月", "火", "水", "木", "金", "土", "日"],
    monthTitle: (year: number, month: number) => `${year}年${month + 1}月`,
    monthDay: (month: number, day: number) => `${month}月${day}日`,
  },
  day: {
    today: "今日",
    yesterday: "昨日",
    noDate: "日付なし",
    thisWeek: "今週",
    lastWeek: "先週",
    earlier: "それ以前",
    weekdays: ["日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"],
    /** 日グループの見出しに出す暦日。 */
    monthDay: (month: number, day: number) => `${month}月${day}日`,
    /** Note の作成日。年まで言うのはここだけ。 */
    fullDate: (year: number, month: number, day: number) => `${year}年${month}月${day}日`,
  },
};

export type Messages = typeof ja;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const SHORT_MONTHS = MONTHS.map((month) => month.slice(0, 3));

const en: Messages = {
  common: {
    save: "Save",
    saving: "Saving…",
    saved: "Saved",
    delete: "Delete",
    cancel: "Cancel",
    back: "Back",
    close: "Close",
    undo: "Undo",
    all: "All",
    tags: "Tags",
  },
  header: {
    searchPlaceholder: "Search or run a command…",
    search: "Search",
    jumpToDate: "Jump to a date",
    sync: "Sync",
    settings: "Settings",
  },
  rail: {
    label: "Modes and global actions",
  },
  theme: {
    system: "System",
    light: "Light",
    dark: "Dark",
  },
  hints: {
    pill: (modifier: string) => `Let go of ${modifier} to hide · ? for the list`,
  },
  scrawl: {
    promote: "Make a Note",
    unlink: (title: string) => `Unlink “${title}”`,
    unlinked: "Note unlinked from this day",
    emptyToday: "Nothing recorded today yet.",
    emptyHint: "Write in the field below and it lands here with the time.",
    deleted: (count: number) => `Deleted ${count} ${count === 1 ? "entry" : "entries"}`,
    digestTitle: "This week",
    digestClose: "Hide until next week",
    digestSummary: (days: number, count: number) =>
      `${count} ${count === 1 ? "record" : "records"} over ${days} ${days === 1 ? "day" : "days"}`,
    lastYear: "A year ago today",
    lastYearOpen: "See this day a year ago",
    selectHint: "Choose the entries to delete",
    select: "Select",
    entryCount: (count: number) => `${count}`,
    bulkDelete: "Delete several",
    selectedCount: (count: number) => `${count} selected`,
    selectionCleared: "The list was reloaded, so the selection was cleared",
    deleteCount: (count: number) => `Delete (${count})`,
    confirmDelete: (count: number) =>
      `Delete ${count} ${count === 1 ? "entry" : "entries"}. Are you sure?`,
    confirmDeleteYes: "Delete",
  },
  capture: {
    placeholder: "What's on your mind?",
    suggestLabel: "Tag suggestions",
    newTag: (draft: string) => `+ Use “#${draft}” as a new tag`,
  },
  browse: {
    title: "Filter",
    kind: "Kind",
    period: "Period",
    thisMonth: "This month",
    thisWeek: "This week",
    clear: "Clear the filters",
    newestFirst: "Newest first",
    count: (count: number) => `${count} ${count === 1 ? "record" : "records"}`,
    empty: "Nothing recorded with this combination",
    open: "Open",
    toDay: "Go to that day",
    noBody: "(no body — a one-line record)",
  },
  notes: {
    empty: "No Notes yet",
    emptyHint: "Start one with New and it lands here.",
    new: "New",
    pinList: (key: string) => `Keep it open ${key}`,
    unpinList: (key: string) => `Let it fold again ${key}`,
    listHint: (key: string) => `${key} keeps it open · it folds when you leave`,
    listPinnedHint: (key: string) => `${key} lets it fold again`,
    noSelection: "Nothing to show",
    backToList: "Back to the list",
    info: "Note info",
    readOnly: "Read-only",
    actions: "Actions for this Note",
    layMap: "Lay the map alongside",
    hideMap: "Close the map",
    makeReadOnly: "Make read-only",
    makeEditable: "Make editable",
    revert: "Back to before this edit",
    savedAt: (time: string) => `Saved at ${time}`,
    titlePlaceholder: "Title",
    bodyPlaceholder: "Write a Note…",
    backlinks: (count: number) => `Records linking here (${count})`,
    untitled: "(empty Note)",
    deleted: "Note deleted",
    reverted: "Restored the body from before the edit",
    revertFailed: "Could not restore it",
    editedElsewhere:
      "This Note was changed elsewhere and has been reloaded. Revert brings your text back",
    staleNotReloaded:
      "It was changed elsewhere, so it was not saved. The copy on disk could not be reloaded, so what is on screen is still your own text. It is kept on this device, but copy it somewhere else as well",
    brokenMeta:
      "This Note's frontmatter cannot be read, so it was not saved. Your text is kept on this device — reopen the Note and Revert puts it back on screen",
    notTextNote:
      "This Note's file is not readable text, so it was not saved. Your text is kept on this device, but reopening the Note cannot read it — copy your text somewhere else while it is still on screen",
    missingNote:
      "This Note no longer exists, so it cannot be saved. Copy your text somewhere else while it is still on screen",
    shownFromBackup:
      "The copy kept on this device is back on screen. It cannot be written to this Note, so copy it somewhere else",
    saveNotKept:
      "It could not be saved, and no copy could be kept on this device either. Closing this loses your text — copy it somewhere else",
    staleNotKept:
      "It was changed elsewhere, so it was not saved, and no copy could be kept on this device either. Your text is gone",
    editedElsewhereAway: (title: string) =>
      `"${title}" was changed elsewhere, so it was not saved. Your text is kept on this device — reopen "${title}" and Revert puts it back on screen`,
    missingNoteAway: (title: string) =>
      `"${title}" no longer exists. Your text is kept on this device, but a deleted Note cannot be opened, so it cannot be put on screen yet`,
    brokenMetaAway: (title: string) =>
      `"${title}" cannot be saved because its frontmatter cannot be read. Your text is kept on this device — reopen it and Revert puts it back on screen`,
    notTextNoteAway: (title: string) =>
      `"${title}" cannot be saved because its file is not readable text. Your text is kept on this device, but a Note that cannot be read cannot be opened, so it cannot be put on screen yet`,
    saveNotKeptAway: (title: string) =>
      `"${title}" could not be saved, and no copy could be kept on this device either. Your text is gone`,
    loadFailed: "This Note could not be read, so its body stays closed rather than be overwritten",
  },
  codex: {
    empty: "Nothing is growing yet",
    emptyHint: "Turn a Note into a Codex from its … menu, or start one with New.",
    promote: "Make a Codex",
    promoteBody1:
      "It becomes a document you keep adding to. Commit a version at each milestone and look back at how much changed since the last one.",
    promoteBody2: "It moves to the Codex tab. Its ID and links stay the same.",
    promoteBody2Strong: "It cannot go back to being a Note.",
    promoteYes: "Make a Codex",
    promoted: "Made a Codex",
    commit: "Commit a version",
    committed: (n: number) => `Committed version ${n}`,
    commitFailed: "Could not commit it",
    history: "History",
    draft: "Draft",
    now: "now",
    restore: "Restore this version",
    restored: "Restored this version. The draft from before is in the history",
    restoredNotShown:
      "Restored this version, but its body could not be put on screen. Please reopen the Codex",
    restoreFailed: "Could not restore it",
    same: "Same content",
    sameShort: "same",
    noVersions: "No versions",
    noVersionsHint: "No versions yet. The current text becomes the first one.",
    close: "Close",
    versionN: (n: number) => `v${n}`,
    deltaFromLatest: (n: number, delta: number) => `${sizeDelta(delta)} since v${n}`,
    cadence: (count: number, span: Span): string => {
      const versions = `${count} version${count === 1 ? "" : "s"}`;
      if (span.months >= 1) {
        return `${versions} in ${span.months} month${span.months === 1 ? "" : "s"}`;
      }
      return span.days >= 1
        ? `${versions} in ${span.days} day${span.days === 1 ? "" : "s"}`
        : `${versions} today`;
    },
    sinceDays: (days: number) => `after ${days} day${days === 1 ? "" : "s"}`,
    pageMark: (count: number, dirty: boolean): string => {
      if (count === 0) {
        return "No versions";
      }
      const versions = `${count} version${count === 1 ? "" : "s"}`;
      return dirty ? `${versions} · changed` : versions;
    },
    monthOf: (month: number) => SHORT_MONTHS[month - 1] ?? String(month),
    sizeDelta,
    sizeOf,
    beforeRestore: "before restore",
  },
  templates: {
    title: "Templates",
    manage: "Manage templates",
    manageLink: "Manage templates…",
    manageHint: "Create and edit the templates you start Notes from",
    fromTemplate: "From a template",
    emptyNote: "Empty Note",
    newNote: "New Note",
    new: "New",
    empty: "No templates yet",
    emptyHint: "Create one with New and it lands here.",
    noSelection: "Choose a template",
    namePlaceholder: "Template name",
    titlePlaceholder: "Title",
    bodyPlaceholder: "Write the template…",
    autoTags: "Auto tags",
    addTag: "Add a tag",
    removeTag: (tag: string) => `Remove the tag ${tag}`,
    insertVariable: "Insert a variable",
    allVariables: "All variables",
    varDate: "date",
    varTime: "time",
    varWeekday: "weekday",
    varPrev: "previous Note",
    todayPreview: "Made today",
    nameTaken: "A template with this name already exists",
    fileHint: "Templates are plain Markdown in templates/*.md and sync as they are",
    deleted: "Template deleted",
    unsaved: "Unsaved",
    discarded: "Discarded the unsaved changes",
    saveFailed: "Could not save the template",
    createFailed: "Could not create a Note from this template",
    reused: (name: string) => `Opened today's “${name}”`,
    count: (count: number) => `${count}`,
    backToSettings: "Back to settings",
    backToList: "Back to the list",
    untitled: "(unnamed)",
  },
  meta: {
    unreadable: "Cannot read the metadata",
    createdAt: "Created",
    updatedAt: "Updated",
    removeTag: (tag: string) => `Remove the tag ${tag}`,
    addTag: "Add a tag",
    tagsHint: "Recorded at creation. Edit #tags in the body itself",
    context: "Recorded surroundings",
    backup: "Backup on this device",
    revert: "Restore the pre-edit body",
    revertHint: "Swaps in the body your last edit overwrote. Press again to swap back",
    saveFailed: "Could not save it",
    os: "OS",
    battery: "Battery",
    charging: "charging",
    network: "Network",
    hostname: "Hostname",
    location: "Location",
    locale: "Locale",
    source: "Written with",
    sourceApp: "App",
    sourceCli: "CLI",
    sourceMcp: "MCP",
    sourceWidget: "Widget",
    sourceImport: "Import",
    wifi: "Wi-Fi",
    ethernet: "Ethernet",
    mobile: "Mobile data",
    offline: "Offline",
  },
  sync: {
    synced: "Everything is synced",
    syncing: "Syncing…",
    notSyncing: "Not syncing",
    failed: "Sync failed",
    localOnly:
      "Everything you write stays on this device. Set this up only when you want other devices to match.",
    lastSync: (when: string) => `Last synced ${when}`,
    autoSync: "Sync automatically on save",
    retry: "Try again",
    now: "Sync now",
    openSettings: "Open settings",
    notConfigured: "Sync is not set up",
    notSignedIn: "Not signed in",
    configCorrupt: "The sync settings file is damaged. Saving is blocked so it is not overwritten",
    justNow: "just now",
    minutesAgo: (minutes: number) => `${minutes} min ago`,
    hoursAgo: (hours: number) => `${hours} h ago`,
    daysAgo: (days: number) => `${days} d ago`,
    result: {
      upToDate: "Already up to date",
      synced: (parts: string) => `Synced ${parts}`,
      conflictsSaved: (count: number) => `${count} conflict(s) saved as copies`,
      failed: (count: number, first: string) => `${count} item(s) failed — ${first}`,
      issue: (issue: SyncIssue) => {
        switch (issue.kind) {
          case "unsafe_key": {
            return `${issue.key}: unsafe name, not synced`;
          }
          case "missing_local_file": {
            return `${issue.key}: gone by the time it was sent`;
          }
          case "read_failed": {
            return `${issue.key}: could not be read (${issue.detail})`;
          }
          case "write_failed": {
            return `${issue.key}: could not be written (${issue.detail})`;
          }
          case "decode_failed": {
            return `${issue.key}: what arrived could not be decoded (${issue.detail})`;
          }
          case "delete_failed": {
            return `${issue.key}: could not be deleted (${issue.detail})`;
          }
          case "delete_skipped_changed": {
            return `${issue.key}: changed during the sync, so it was kept`;
          }
        }
      },
    },
  },
  settings: {
    title: "Settings",
    notSet: "Not set",
    signedIn: "Signed in",
    notSignedIn: "Not signed in",
    signInGoogle: "Sign in with Google",
    signOut: "Sign out",
    signInHint: "Save the Workers URL before signing in.",
    signedInMessage: "Signed in",
    signInFailed: (reason: string) => `Could not sign in: ${reason}`,
    saveFailed: (reason: string) => `Could not save: ${reason}`,
    continueSignIn: "Continue signing in…",
    signedOutMessage: "Signed out",
    signOutFailed: (reason: string) => `Could not sign out: ${reason}`,
    theme: "Theme",
    language: "Language",
    languageSystem: "System",
    languageJa: "日本語",
    languageEn: "English",
    startFullscreen: "Start in fullscreen",
    startFullscreenHint: "Applies from the next launch",
    glyphs: "Glyphs",
    glyphsHint:
      "Register an image and write :name: in a Note or a Scrawl entry to show it there. PNG or SVG, up to 256 KB.",
    glyphsEmpty: "Nothing registered yet",
    addGlyph: "Add an image",
    addGlyphsFolder: "Add a folder",
    glyphsFolderHint:
      "Choosing a folder registers every PNG and SVG in it under its file name; an existing name is overwritten. Files placed straight into data/glyphs/ are picked up too.",
    glyphsImported: (saved: number, skipped: number) =>
      skipped > 0 ? `Registered ${saved} (skipped ${skipped})` : `Registered ${saved}`,
    glyphName: "Name",
    glyphNameHint: "Lowercase letters, digits, _ + - only; up to 32 characters",
    glyphUnsupported: "Choose a PNG or SVG image",
    deleteGlyph: (name: string) => `Delete :${name}:`,
    glyphDeleted: "Glyph deleted",
    glyphSaved: (name: string) => `Registered :${name}:`,
    glyphSaveFailed: (reason: string) => `Could not register it: ${reason}`,
    version: "Version",
  },
  palette: {
    dialogLabel: "Search and commands",
    commands: "Commands",
    dates: "Dates",
    recentNotes: "Recent Notes",
    hits: "Notes and Scrawl entries",
    empty: "Nothing matches",
    count: (count: number) => `${count}`,
    newNote: "New Note",
    openScrawl: "Open Scrawl",
    openNotes: "Open Note",
    openCodex: "Open Codex",
    openBrowse: "Filter by tag",
    openSettings: "Open Settings",
    scopeTag: (tag: string) => `Scoped to #${tag}`,
    removeScope: "Remove the scope",
    emptyScoped: (scope: string) => `Nothing in ${scope} matches`,
  },
  editor: {
    copyCode: "Copy the code",
    language: "Language",
    diagramFailed: "Cannot draw this diagram",
    exitBlock: "Leave the block",
    deleteBlock: "Delete the block",
    bulletList: "Bulleted list",
    orderedList: "Numbered list",
    taskList: "Checklist",
    outdent: "Outdent",
    indent: "Indent",
    codeBlock: "Code block",
    horizontalRule: "Horizontal rule",
  },
  preview: {
    zoom: "Zoom",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    fit: "Fit",
    zoomHint: "Scroll to zoom / drag to pan / Esc to close",
    saveSvg: "Save as SVG",
    savePng: "Save as PNG",
    exportFailed: "Could not save the diagram",
  },
  firstRun: {
    title: "You can set up sync later",
    body: "Without it, everything you write stays on this device. If that is fine, start writing as you are.",
    hint: "When you want the same records on more than one device, put the Workers URL here or in settings.",
    connect: "Connect",
    later: "Later",
  },
  calendar: {
    prevMonth: "Previous month",
    nextMonth: "Next month",
    weekdays: ["M", "T", "W", "T", "F", "S", "S"],
    monthTitle: (year: number, month: number) => `${MONTHS[month] ?? String(month + 1)} ${year}`,
    monthDay: (month: number, day: number) => `${SHORT_MONTHS[month - 1] ?? month} ${day}`,
  },
  day: {
    today: "Today",
    yesterday: "Yesterday",
    noDate: "No date",
    thisWeek: "This week",
    lastWeek: "Last week",
    earlier: "Earlier",
    weekdays: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    monthDay: (month: number, day: number) => `${SHORT_MONTHS[month - 1] ?? month} ${day}`,
    fullDate: (year: number, month: number, day: number) =>
      `${SHORT_MONTHS[month - 1] ?? month} ${day}, ${year}`,
  },
};

export const messages: Record<Locale, Messages> = { ja, en };

const STORAGE_KEY = "locale";

function isPreference(value: unknown): value is LocalePreference {
  return value === "system" || value === "ja" || value === "en";
}

export function readStoredLocale(): LocalePreference {
  const saved = localStorage.getItem(STORAGE_KEY);
  return isPreference(saved) ? saved : "system";
}

/**
 * 実際に使う言語。持っていない言語の端末は英語に倒す — 日本語を
 * 既定にすると、読めない人が読めない設定画面から言語を探すことになる。
 */
export function resolveLocale(preference: LocalePreference, systemLanguage: string): Locale {
  if (preference !== "system") {
    return preference;
  }
  return systemLanguage.toLowerCase().startsWith("ja") ? "ja" : "en";
}

const [locale, setResolved] = createSignal<Locale>(
  resolveLocale(readStoredLocale(), globalThis.navigator?.language ?? "en"),
);

export { locale };

// index.html は `lang="ja"` で出荷される。読み上げと日本語の行組みが
// 言語と食い違わないよう、決まった時点で書き換える
document.documentElement.lang = locale();

/** いま使う言葉の表。JSX から呼べば、切り替えたときに描き直される。 */
export function t(): Messages {
  return messages[locale()];
}

/** 表示だけを切り替える。設定として残すのは `applyLocale`。 */
export function setLocale(next: Locale): void {
  setResolved(next);
  document.documentElement.lang = next;
}

export function applyLocale(preference: LocalePreference): void {
  setLocale(resolveLocale(preference, globalThis.navigator?.language ?? "en"));
  localStorage.setItem(STORAGE_KEY, preference);
}
