# タスク詳細に MilkdownEditor を追加 (Issue #14)

## Context

タスク詳細画面は現在 MarkdownPreview による読み取り専用表示。ノートは既に MilkdownEditor で直接編集 + デバウンス自動保存を実現している。タスクとノートの編集体験を統一し、タスクのbodyをインラインで編集可能にする。

## Milkdown プラグイン調査結果

既存の MilkdownEditor コンポーネントに必要なプラグインは全て含まれている:

- `commonmark`, `listener`, `highlight`, `cursor`, `history`, `clipboard`, `trailing`, `linkTooltipPlugin`, `exitCodeBlockPlugin`, `placeholderPlugin`

**新規プラグインは不要** — MilkdownEditor をそのまま再利用できる。

## 変更対象ファイル

| ファイル                         | 変更内容                               |
| -------------------------------- | -------------------------------------- |
| `tauri-app/src/views/Tasks.tsx`  | ViewMode拡張、editモード追加、自動保存 |
| `tauri-app/src/styles/tasks.css` | タイトル入力の新規CSS (2クラスのみ)    |

**変更なし**: `MilkdownEditor.tsx`, `ActionBar.tsx`, Rust backend (`update_task` は既存)

## 再利用するもの

- `MilkdownEditor` コンポーネント (`src/components/MilkdownEditor.tsx`)
- Notes.tsx の自動保存パターン (debounce 1秒 + `createEffect(on(...))`)
- CSS: `.view--flush`, `.notes-editor`, `.tags-input`, `.status-indicator` (全て既存)

## 設計方針

- **アクティブタスク** → `"edit"` モード (MilkdownEditor で即時編集)
- **完了済みタスク** → `"preview"` モード (MarkdownPreview のまま)
- タイトルは `<input>` で編集 (Milkdownの外、ヘッダー部分)
- タグは ActionBar 内の既存 `.tags-input` パターン
- body / title / tags いずれの変更も 1秒デバウンスで `update_task` を自動呼び出し

## 実装ステップ

### Step 1: Tidy First — ViewMode 拡張 (構造変更のみ)

`Tasks.tsx` のみ変更:

1. `type ViewMode = "list" | "edit" | "preview"` に拡張
2. `openPreview` を `openTask` にリネームし、アクティブ→`"edit"`、完了→`"preview"` に分岐
3. `"edit"` の `<Match>` ブロックを追加 (中身は preview と同じコピー — 動作確認用)
4. JSX の呼び出し元を `openPreview` → `openTask` に更新

**確認**: アクティブ/完了タスクがそれぞれ正しいモードで開くこと

### Step 2: editモードに MilkdownEditor を配置

`Tasks.tsx`:

1. import 追加: `MilkdownEditor`, `on`, `onCleanup`
2. 新規シグナル追加:
   - `taskBody` / `taskTitle` / `taskTagsInput` — 編集状態
   - `saveStatus` — `"idle" | "saving" | "saved"`
3. `openTask` 内でシグナルを初期化 (task.body, task.title, task.tags)
4. `"edit"` Match ブロックを差し替え:
   - ヘッダー: `<input>` でタイトル編集
   - ボディ: `<MilkdownEditor defaultValue={taskBody()} onChange={setTaskBody} placeholder="Write task details..." />`
   - ステータス: `<span class="status-indicator">` (既存CSSを再利用)
   - ActionBar: tags入力 + 戻る + 完了 + 削除
5. ルートの `<div class="view">` に `classList={{ "view--flush": viewMode() === "edit" }}` を追加

### Step 3: デバウンス自動保存

`Tasks.tsx`:

1. `saveTimer` 変数 + `parseTaskTags()` ヘルパー
2. `saveTask()`: `invoke("update_task", { projectSlug, filename, title, tags, body })` を呼び出し
3. `scheduleSaveTask()`: 1秒デバウンス
4. `createEffect(on(taskBody, ...))` / `on(taskTitle, ...)` / `on(taskTagsInput, ...)` で自動保存
5. `onCleanup` でタイマークリア
6. `goBack` を更新: 戻る前に pending な保存をフラッシュ + `refetchTasks()`

### Step 4: CSS 追加

`tasks.css` に2クラスのみ追加:

```css
.task-edit-header {
  padding: var(--size-2) var(--size-3);
  border-bottom: 1px solid var(--app-border);
}

.task-title-input {
  width: 100%;
  padding: var(--size-1) 0;
  border: none;
  background: transparent;
  color: var(--app-text);
  font-size: var(--font-size-3);
  font-weight: var(--font-weight-6);
  outline: none;
}

.task-title-input::placeholder {
  color: var(--app-text-muted);
}
```

## 検証

- [ ] アクティブタスク → MilkdownEditor で開く、本文・タイトル・タグ編集可能
- [ ] 編集後 1秒で "Saving..." → "Saved" 表示
- [ ] 戻るボタンで保存がフラッシュされ、一覧に反映
- [ ] 完了済みタスク → MarkdownPreview のまま (変更なし)
- [ ] 完了ボタン・削除ボタンが editモードから動作する
- [ ] 空body → placeholder "Write task details..." が表示される
- [ ] 既存テスト (`pnpm test`) がパスする
