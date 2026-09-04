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
    theme: (name: string) => `テーマ: ${name}`,
    settings: "Settings",
  },
  theme: {
    system: "システム",
    light: "ライト",
    dark: "ダーク",
  },
  timeline: {
    promote: "ノートにする",
    unlink: (title: string) => `「${title}」との関係を解除`,
    unlinked: "ノートとの関係を解除しました",
    emptyFiltered: "このタグの記録はまだありません。",
    emptyToday: "今日はまだ何も記録していません。",
    emptyFilteredHint: "上のチップで絞り込みを外せます。",
    emptyHint: "下の入力欄に書くと、時刻とともにここに並びます。",
    deleted: (count: number) => `${count}件のエントリを削除しました`,
    digestTitle: "今週のふりかえり",
    digestClose: "今週は閉じる",
    digestSummary: (days: number, count: number) => `${days}日で${count}件を記録`,
    lastYear: "1年前の今日の記録を見る",
    selectHint: "消すエントリを選んでください",
    select: "選択",
    entryCount: (count: number) => `${count}件`,
    bulkDelete: "まとめて削除",
    selectedCount: (count: number) => `${count}件選択中`,
    deleteCount: (count: number) => `削除 (${count}件)`,
    confirmDelete: (count: number) => `${count}件のエントリを削除します。よろしいですか？`,
    confirmDeleteYes: "削除する",
  },
  capture: {
    placeholder: "いま何を記録する？",
    suggestLabel: "タグ候補",
    newTag: (draft: string) => `+「#${draft}」を新規タグとして確定`,
  },
  tagFilter: {
    filtering: (tag: string, matched: number) => `#${tag} で絞り込み中 · ${matched}件`,
  },
  notes: {
    empty: "ノートがありません",
    emptyHint: "新規から始めると、ここに並びます。",
    new: "新規",
    noSelection: "項目がありません",
    backToList: "一覧に戻る",
    showEditor: "エディタで表示",
    showMindmap: "マインドマップで表示",
    showPreview: "読み取り専用で表示",
    info: "ノート情報",
    finishEditing: "編集を終える",
    titlePlaceholder: "タイトル",
    bodyPlaceholder: "ノートを書く…",
    backlinks: (count: number) => `リンクされている記録 (${count})`,
    untitled: "(空のメモ)",
    deleted: "ノートを削除しました",
    reverted: "編集前の内容に戻しました",
    revertFailed: "戻せませんでした",
    editedElsewhere:
      "別の場所で書き換えられたので読み直しました。入力した本文は「戻す」で呼び出せます",
  },
  templates: {
    title: "テンプレート",
    manage: "テンプレートを管理",
    manageLink: "テンプレートを管理…",
    manageHint: "ノート作成時に使うテンプレートの作成・編集",
    fromTemplate: "テンプレートから",
    emptyNote: "空のノート",
    newNote: "新規ノート",
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
    varPrev: "前回のノート",
    todayPreview: "今日作ると",
    nameTaken: "同じ名前のテンプレートがあります",
    fileHint: "テンプレは templates/*.md の素の Markdown ファイル。同期にもそのまま乗る",
    deleted: "テンプレートを削除しました",
    unsaved: "未保存",
    discarded: "保存していない変更を破棄しました",
    saveFailed: "テンプレートを保存できませんでした",
    createFailed: "テンプレートからノートを作れませんでした",
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
  },
  palette: {
    dialogLabel: "検索・コマンド",
    commands: "コマンド",
    dates: "日付",
    recentNotes: "最近のノート",
    hits: "ノート・エントリ",
    empty: "一致するものがありません",
    count: (count: number) => `${count}件`,
    newNote: "新規ノート",
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
    theme: (name: string) => `Theme: ${name}`,
    settings: "Settings",
  },
  theme: {
    system: "System",
    light: "Light",
    dark: "Dark",
  },
  timeline: {
    promote: "Turn into a note",
    unlink: (title: string) => `Unlink “${title}”`,
    unlinked: "Note unlinked from this day",
    emptyFiltered: "Nothing recorded with this tag yet.",
    emptyToday: "Nothing recorded today yet.",
    emptyFilteredHint: "Drop the filter with the chips above.",
    emptyHint: "Write in the field below and it lands here with the time.",
    deleted: (count: number) => `Deleted ${count} ${count === 1 ? "entry" : "entries"}`,
    digestTitle: "This week",
    digestClose: "Hide until next week",
    digestSummary: (days: number, count: number) =>
      `${count} ${count === 1 ? "record" : "records"} over ${days} days`,
    lastYear: "See this day a year ago",
    selectHint: "Choose the entries to delete",
    select: "Select",
    entryCount: (count: number) => `${count}`,
    bulkDelete: "Delete several",
    selectedCount: (count: number) => `${count} selected`,
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
  tagFilter: {
    filtering: (tag: string, matched: number) => `Filtered by #${tag} · ${matched}`,
  },
  notes: {
    empty: "No notes yet",
    emptyHint: "Start one with New and it lands here.",
    new: "New",
    noSelection: "Nothing to show",
    backToList: "Back to the list",
    showEditor: "Show as text",
    showMindmap: "Show as a mindmap",
    showPreview: "Show as a read-only preview",
    info: "Note info",
    finishEditing: "Finish editing",
    titlePlaceholder: "Title",
    bodyPlaceholder: "Write a note…",
    backlinks: (count: number) => `Records linking here (${count})`,
    untitled: "(empty note)",
    deleted: "Note deleted",
    reverted: "Restored the body from before the edit",
    revertFailed: "Could not restore it",
    editedElsewhere:
      "This note was changed elsewhere and has been reloaded. Revert brings your text back",
  },
  templates: {
    title: "Templates",
    manage: "Manage templates",
    manageLink: "Manage templates…",
    manageHint: "Create and edit the templates you start notes from",
    fromTemplate: "From a template",
    emptyNote: "Empty note",
    newNote: "New note",
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
    varPrev: "previous note",
    todayPreview: "Made today",
    nameTaken: "A template with this name already exists",
    fileHint: "Templates are plain Markdown in templates/*.md and sync as they are",
    deleted: "Template deleted",
    unsaved: "Unsaved",
    discarded: "Discarded the unsaved changes",
    saveFailed: "Could not save the template",
    createFailed: "Could not create a note from this template",
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
    language: "Language",
    languageSystem: "System",
    languageJa: "日本語",
    languageEn: "English",
    startFullscreen: "Start in fullscreen",
    startFullscreenHint: "Applies from the next launch",
    glyphs: "Glyphs",
    glyphsHint:
      "Register an image and write :name: in a note or entry to show it there. PNG or SVG, up to 256 KB.",
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
  },
  palette: {
    dialogLabel: "Search and commands",
    commands: "Commands",
    dates: "Dates",
    recentNotes: "Recent notes",
    hits: "Notes and entries",
    empty: "Nothing matches",
    count: (count: number) => `${count}`,
    newNote: "New note",
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
