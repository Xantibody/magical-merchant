/**
 * The words that appear on screen. It holds Japanese and English only.
 *
 * No library was added. All that is needed is "hold two tables and return one of them":
 * no plural rules, no date format negotiation, and a sentence that takes a number is a
 * function. As with the theme (`theme.ts`), the choice is kept in localStorage, and
 * system follows the device setting.
 *
 * `t()` reads a signal. Called from JSX or inside createMemo, it is redrawn the moment the
 * language is switched, and the tracking is not cut even through a function that hands out
 * strings (`day-labels.ts` and the like).
 */

import { createSignal } from "solid-js";
import type { SyncIssue } from "./sync-status";

export type Locale = "ja" | "en";

/**
 * The byte difference between versions. `+1.2 KB` / `−340 B` / `±0`. The unit is spelled
 * the same in both languages, so one function is pointed at from both, not two tables.
 */
function sizeDelta(bytes: number): string {
  if (bytes === 0) {
    return "±0";
  }
  const sign = bytes > 0 ? "+" : "−";
  const size = Math.abs(bytes);
  return size < 1024 ? `${sign}${size} B` : `${sign}${(size / 1024).toFixed(1)} KB`;
}

/** The size itself. The oldest version shows this instead of a difference. `820 B` / `1.1 KB`. */
function sizeOf(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** The span in "committed M versions over N months". In days when a month is not full. */
interface Span {
  months: number;
  days: number;
}
/** The value kept in the settings. `system` follows the device's language. */
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
    saveFailed: "記録を保存できませんでした。入力は残っています。",
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
    /** A one-line record. The title is the whole text, so there is no body to show below */
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
    readOnly: "読み取り専用",
    /** The right panel's name. Upper case is CSS's job (`.list-pane-title`). */
    panel: "この Note",
    panelFootHover: (key: string) => `右端に置くと開く · ${key} で固定`,
    panelFootPinned: (key: string) => `${key} で閉じる`,
    view: "表示",
    map: "マップ",
    examples: "記入例",
    /** Both live in the one frontmatter key `view`, so turning one on turns the other off. */
    viewExclusive: "読み取り専用とマップはどちらか一方",
    details: "詳細",
    revert: "編集前に戻す",
    revertNeedsEdit: "この端末で編集するとここから戻せます",
    revertReadOnly: "読み取り専用のあいだは戻せません",
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
     * When the write gave way but the reload never reached the screen (it could not be
     * read, or typing began before it arrived). What is on screen is still the typed body,
     * so saying "it was reloaded" makes people stop copying, believing they are looking at
     * the disk's version.
     */
    staleNotReloaded:
      "別の場所で書き換えられていたので保存できませんでした。ディスクの本文は読み直せず、画面にあるのは入力した本文のままです。この端末に控えましたが、別の場所へも写してください",
    brokenMeta:
      "この Note の先頭の記録が読めないので保存できません。入力した本文はこの端末に控えました。開き直せば「戻す」で画面に出せます",
    /**
     * The file itself cannot be read as text. What is broken is the contents, not the
     * leading record, so the wording is kept apart from `brokenMeta`: reopening it has
     * `read_note` refuse for the same reason, and there is no way to put the backup on
     * screen with "undo".
     */
    notTextNote:
      "この Note のファイルは文字として読めないので保存できません。入力した本文はこの端末に控えましたが、開き直しても読めないので、画面にあるうちに別の場所へ写してください",
    /** A missing Note loses its whole row, so it cannot be said that "undo" will bring it back. */
    missingNote:
      "この Note はもう在りません。保存できないので、入力した本文は画面にあるうちに別の場所へ写してください",
    shownFromBackup:
      "この端末に控えた本文を画面に出しました。この Note のディスクには書けないので、別の場所へ写してください",
    saveNotKept:
      "保存できず、この端末にも控えを残せませんでした。閉じると入力した本文は失われます。別の場所へ写してください",
    saveFailedKept: (title: string) =>
      `「${title}」を保存できませんでした。入力した本文はこの端末に控えました。保存が復旧してから、開き直して「戻す」で取り出してください`,
    /**
     * When it was Stale and no backup could be kept either. The body on screen has been
     * swapped for the disk's, so telling the user to "copy it while it is on screen" leaves
     * nothing to copy.
     */
    staleNotKept:
      "別の場所で書き換えられていたので保存できず、この端末にも控えを残せませんでした。入力した本文は失われました",
    /**
     * The wording for when the refused Note is not on screen. What is on screen is another
     * Note's body, so "copy it while it is on screen" does not land. It names which Note,
     * and says only where the backup is and whether it can be taken out now.
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
    emptyHint: "Note のパネルから Codex にするか、新規から始めます。",
    /** The right panel's first tab on a Codex. */
    panel: "この Codex",
    promote: "Codex にする",
    /** The second line under "Make a Codex" in the panel. What is gained, before any confirmation. */
    promoteSub: "版を刻める文書として育てる",
    /** The confirmation for "make it a Codex". What is gained comes first, no way back last. */
    promoteConfirm: "版を刻める文書として Codex タブに移ります。Codex から Note には",
    promoteConfirmStrong: "戻せません",
    promoteConfirmEnd: "。",
    promoteYes: "Codex にする",
    promoteNo: "やめる",
    promoted: "Codex にしました",
    commit: "版を刻む",
    committed: (n: number) => `版 ${n} を刻みました`,
    commitFailed: "刻めませんでした",
    history: "履歴",
    draft: "下書き",
    restored: "この版に戻しました。戻す前の下書きは履歴にあります",
    /**
     * The restoring write went through, but the reload after it never reached the screen.
     * It cannot be called restored: what is on screen is the body from before the restore,
     * so the message goes as far as telling the user to reopen it.
     */
    restoredNotShown:
      "この版に戻しましたが、戻した本文を画面に出せませんでした。開き直してください",
    restoreFailed: "戻せませんでした",
    sameShort: "同じ内容",
    noVersions: "版なし",
    noVersionsHint: "まだ版がありません。いまの本文が最初の版になります。",
    close: "閉じる",
    /** "Version 4". The spine row, the meta line, and the description of the list's mark. */
    versionN: (n: number) => `版 ${n}`,
    /** "+312 B from version 4". The distance from the latest version. */
    deltaFromLatest: (n: number, delta: number) => `版 ${n} から ${sizeDelta(delta)}`,
    /** "Committed 4 versions over 9 months". The time since the first version and the count. */
    cadence: (count: number, span: Span): string => {
      if (span.months >= 1) {
        return `${span.months} か月で ${count} 回刻んだ`;
      }
      return span.days >= 1 ? `${span.days} 日で ${count} 回刻んだ` : `今日 ${count} 回刻んだ`;
    },
    /** "After 7 days". The toast right after a version is committed. */
    sinceDays: (days: number) => `${days} 日ぶり`,
    /** The description of the folded-corner page in the list. */
    pageMark: (count: number, dirty: boolean): string => {
      if (count === 0) {
        return "版なし";
      }
      return dirty ? `版 ${count} · 変更あり` : `版 ${count}`;
    },
    /** The second line of the draft row. Which number it becomes once committed. */
    nextVersion: (n: number) => `刻めば版 ${n}`,
    /** When the draft has not moved from the latest version. */
    sameAsVersion: (n: number) => `版 ${n} と同じ内容`,
    /** "First version · 2.1 KB". The second line of the oldest row. */
    firstVersion: (bytes: number) => `最初の版 · ${sizeOf(bytes)}`,
    /** The "restore version 3" shown under the selected version. */
    restoreN: (n: number) => `版 ${n} に戻す`,
    /** From the phone's history screen the way back is the body, not the list. Say so to the reader. */
    backToBody: "本文に戻る",
    /** Inside the compare bar. It is narrow, so the line above says the version number. */
    restoreShort: "戻す",
    /** The foot of the panel while the history tab is open. */
    historyFoot: "版を押すと本文で比べる · Esc で閉じる",
    /** What compare mode calls itself. The compare bar and the bottom bar show it. */
    comparing: (n: number) => `版 ${n} と比較中`,
    /** "3 lines added · 1 line removed". The lines moved between the chosen version and the draft. */
    lineDelta: (added: number, removed: number): string =>
      [added > 0 ? `${added} 行追加` : undefined, removed > 0 ? `${removed} 行削除` : undefined]
        .filter(Boolean)
        .join(" · "),
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
    varExample: "記入例",
    todayPreview: "今日作ると",
    nameTaken: "同じ名前のテンプレートがあります",
    fileHint: "テンプレは templates/*.md の素の Markdown ファイル。同期にもそのまま乗る",
    deleted: "テンプレートを削除しました",
    unsaved: "未保存",
    discarded: "保存していない変更を破棄しました",
    discardDraft: "保存していない変更を破棄",
    saveFailed: "テンプレートを保存できませんでした",
    createFailed: "テンプレートから Note を作れませんでした",
    reused: (name: string) => `今日の「${name}」を開きました`,
    count: (count: number) => `${count}件`,
    backToSettings: "設定に戻る",
    backToList: "一覧に戻る",
    untitled: "(名前なし)",
  },
  tags: {
    /** The label over the meta line's suggestions. */
    suggestLabel: "使ったことのあるタグ",
    addNew: (q: string) => `「${q}」を新しく追加`,
    footHint: "本文の #タグ は本文側で編集 · ↑↓ Enter Esc",
    /** The `+ tag` at the end of the meta line. */
    addShort: "タグ",
    /** The dashed chip in the phone's panel screen. */
    add: "追加",
    /** A tag that comes from the body's `#tag`. It cannot be removed from here. */
    fromBody: "本文の #タグ は本文側で編集",
  },
  meta: {
    unreadable: "メタデータを読み取れません",
    created: "作成",
    updated: "更新",
    environment: "環境",
    removeTag: (tag: string) => `タグ ${tag} を外す`,
    addTag: "タグを追加",
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
    // The report after one sync finishes. The core returns only the kind and the material,
    // so the sentence is made here (describeSyncResult in `sync-status.ts`)
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
    // The three page titles, the nav subtitles and the page leads. A nav row becomes the page's head
    pages: {
      general: {
        title: "一般",
        hint: "言語 · テーマ",
        lead: "この端末だけの設定。",
      },
      records: {
        title: "記録",
        hint: "テンプレート · 特殊文字",
        lead: "Note の雛形と、本文に出る画像。",
      },
      sync: {
        title: "同期",
        // The page has only two rows, so the title alone is enough
        hint: "",
        lead: "Cloudflare Workers + R2。端末は自分の状態を送らず、Worker が正を持つ。",
      },
    },
    backToPages: "設定の一覧に戻る",
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
    themeDesc: "システムは端末の設定に従う",
    language: "言語",
    languageDesc: "表示に使う言語",
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
    workersUrl: "Workers URL",
    workersUrlDesc: "デプロイした Worker のアドレス",
    account: "アカウント",
    accountDesc: "Google でログイン",
    // The only place that names the build on the device. The number is the tauri.conf.json
    // value `getVersion()` returns, and it matches the release tag
    versionLine: (version: string) => `Magical Merchant ${version}`,
  },
  palette: {
    dialogLabel: "検索・コマンド",
    commands: "コマンド",
    dates: "日付",
    recentNotes: "最近の Note",
    empty: "一致するものがありません",
    count: (count: number) => `${count}件`,
    // To the right of the input. How many hits there are across all the kinds together
    hitCount: (count: number) => `${count} 件`,
    // The key badges shown at the foot and on the selected row. The symbols are the keys themselves, so they are not translated
    hintMove: "選ぶ",
    hintOpen: "開く",
    hintClose: "閉じる",
    newNote: "新規 Note",
    openScrawl: "Scrawl を開く",
    openNotes: "Note を開く",
    openCodex: "Codex を開く",
    openBrowse: "タグで絞る",
    openSettings: "設定を開く",
    scopeTag: (tag: string) => `#${tag} で絞り込み`,
    removeScope: "絞り込みを外す",
    // The argument is the scope text laid out as "#a #b" (scopeLabel). One sentence covers any number of tags
    emptyScoped: (scope: string) => `${scope} の中に一致するものがありません`,
  },
  editor: {
    table: "表",
    insertTable: "表を挿入",
    rowBefore: "上に行を追加",
    rowAfter: "下に行を追加",
    deleteRow: "行を削除",
    columnBefore: "左に列を追加",
    columnAfter: "右に列を追加",
    deleteColumn: "列を削除",
    left: "左揃え",
    center: "中央揃え",
    right: "右揃え",
    exitTable: "表から抜ける",
    deleteTable: "表を削除",
    undo: "元に戻す",
    copyCode: "コードをコピー",
    language: "言語",
    diagramFailed: "図を描画できません",
    exitBlock: "ブロックから抜ける",
    bulletList: "箇条書き",
    orderedList: "番号付きリスト",
    taskList: "チェックリスト",
    outdent: "インデントを戻す",
    indent: "インデント",
    // A link target can be a Note or a Codex. It says "record", the same word as the backlink text
    noteLink: "記録へのリンク",
    codeBlock: "コードブロック",
    closeKeyboard: "キーボードを閉じる",
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
    /** The week starts on Monday. A weekday heading has only one character of width */
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
    /** The calendar date shown on a day group's heading. */
    monthDay: (month: number, day: number) => `${month}月${day}日`,
    /** A Note's creation date. This is the only place that says the year as well. */
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
    saveFailed: "Could not save the entry. Your text is still here.",
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
    readOnly: "Read-only",
    panel: "This Note",
    panelFootHover: (key: string) => `Rest on the right edge to open · ${key} keeps it`,
    panelFootPinned: (key: string) => `${key} closes it`,
    view: "View",
    map: "Map",
    examples: "Examples",
    viewExclusive: "Read-only and the map take turns",
    details: "Details",
    revert: "Back to before this edit",
    revertNeedsEdit: "Edit on this device and you can step back here",
    revertReadOnly: "No stepping back while it is read-only",
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
    saveFailedKept: (title: string) =>
      `"${title}" could not be saved. Your text is kept on this device. Once saving works again, reopen the Note and use Revert to retrieve it`,
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
    emptyHint: "Turn a Note into a Codex from its panel, or start one with New.",
    panel: "This Codex",
    promote: "Make a Codex",
    promoteSub: "Grow it as a document you commit versions of",
    promoteConfirm: "It moves to the Codex tab as a document you commit versions of. It ",
    promoteConfirmStrong: "cannot go back to being a Note",
    promoteConfirmEnd: ".",
    promoteYes: "Make a Codex",
    promoteNo: "Not now",
    promoted: "Made a Codex",
    commit: "Commit a version",
    committed: (n: number) => `Committed version ${n}`,
    commitFailed: "Could not commit it",
    history: "History",
    draft: "Draft",
    restored: "Restored this version. The draft from before is in the history",
    restoredNotShown:
      "Restored this version, but its body could not be put on screen. Please reopen the Codex",
    restoreFailed: "Could not restore it",
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
    nextVersion: (n: number) => `commit and it is v${n}`,
    sameAsVersion: (n: number) => `same as v${n}`,
    firstVersion: (bytes: number) => `first version · ${sizeOf(bytes)}`,
    restoreN: (n: number) => `Restore v${n}`,
    backToBody: "Back to the document",
    restoreShort: "Restore",
    historyFoot: "Press a version to compare it in the body · Esc closes",
    comparing: (n: number) => `Comparing with v${n}`,
    lineDelta: (added: number, removed: number): string =>
      [
        added > 0 ? `${added} line${added === 1 ? "" : "s"} added` : undefined,
        removed > 0 ? `${removed} line${removed === 1 ? "" : "s"} removed` : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
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
    varExample: "example",
    todayPreview: "Made today",
    nameTaken: "A template with this name already exists",
    fileHint: "Templates are plain Markdown in templates/*.md and sync as they are",
    deleted: "Template deleted",
    unsaved: "Unsaved",
    discarded: "Discarded the unsaved changes",
    discardDraft: "Discard the unsaved changes",
    saveFailed: "Could not save the template",
    createFailed: "Could not create a Note from this template",
    reused: (name: string) => `Opened today's “${name}”`,
    count: (count: number) => `${count}`,
    backToSettings: "Back to settings",
    backToList: "Back to the list",
    untitled: "(unnamed)",
  },
  tags: {
    suggestLabel: "Tags you have used",
    addNew: (q: string) => `Add “${q}” as new`,
    footHint: "Edit #tags in the body itself · ↑↓ Enter Esc",
    addShort: "Tag",
    add: "Add",
    fromBody: "Edit #tags in the body itself",
  },
  meta: {
    unreadable: "Cannot read the metadata",
    created: "Created",
    updated: "Updated",
    environment: "Surroundings",
    removeTag: (tag: string) => `Remove the tag ${tag}`,
    addTag: "Add a tag",
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
    pages: {
      general: {
        title: "General",
        hint: "Language · Theme",
        lead: "Settings for this device alone.",
      },
      records: {
        title: "Records",
        hint: "Templates · Glyphs",
        lead: "Note templates, and the images a body can show.",
      },
      sync: {
        title: "Sync",
        hint: "",
        lead: "Cloudflare Workers + R2. A device never uploads its own state; the Worker owns it.",
      },
    },
    backToPages: "Back to the settings list",
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
    themeDesc: "System follows the device setting",
    language: "Language",
    languageDesc: "The language the app is shown in",
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
    workersUrl: "Workers URL",
    workersUrlDesc: "The address of the Worker you deployed",
    account: "Account",
    accountDesc: "Sign in with Google",
    versionLine: (version: string) => `Magical Merchant ${version}`,
  },
  palette: {
    dialogLabel: "Search and commands",
    commands: "Commands",
    dates: "Dates",
    recentNotes: "Recent Notes",
    empty: "Nothing matches",
    count: (count: number) => `${count}`,
    hitCount: (count: number) => `${count} hits`,
    hintMove: "Move",
    hintOpen: "Open",
    hintClose: "Close",
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
    table: "Table",
    insertTable: "Insert table",
    rowBefore: "Insert row above",
    rowAfter: "Insert row below",
    deleteRow: "Delete row",
    columnBefore: "Insert column left",
    columnAfter: "Insert column right",
    deleteColumn: "Delete column",
    left: "Left",
    center: "Center",
    right: "Right",
    exitTable: "Exit table",
    deleteTable: "Delete table",
    undo: "Undo",
    copyCode: "Copy the code",
    language: "Language",
    diagramFailed: "Cannot draw this diagram",
    exitBlock: "Leave the block",
    bulletList: "Bulleted list",
    orderedList: "Numbered list",
    taskList: "Checklist",
    outdent: "Outdent",
    indent: "Indent",
    noteLink: "Link to a record",
    codeBlock: "Code block",
    closeKeyboard: "Close the keyboard",
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
 * The language actually used. A device in a language that is not held falls to English:
 * with Japanese as the default, someone who cannot read it would have to look for the
 * language in a settings screen they cannot read.
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

// index.html ships with `lang="ja"`. It is rewritten the moment the language is decided,
// so that the screen reader and the Japanese line breaking do not disagree with it
document.documentElement.lang = locale();

/** The table of words in use now. Called from JSX, it is redrawn when the language switches. */
export function t(): Messages {
  return messages[locale()];
}

/** Switch the display only. Keeping it as a setting is `applyLocale`. */
export function setLocale(next: Locale): void {
  setResolved(next);
  document.documentElement.lang = next;
}

export function applyLocale(preference: LocalePreference): void {
  setLocale(resolveLocale(preference, globalThis.navigator?.language ?? "en"));
  localStorage.setItem(STORAGE_KEY, preference);
}
