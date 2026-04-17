# 03: タスク詳細にMilkdownエディタを追加

Issue: #14

## 背景

- タスク詳細は現在 MarkdownPreview による読み取り専用表示
- ノートは既に MilkdownEditor で直接編集 + デバウンス自動保存を実現済み
- タスクとノートの編集体験を統一する

## 要件

### 機能要件

1. **アクティブタスク**: タスク詳細を開いたら即座に MilkdownEditor で編集可能
2. **完了済みタスク**: MarkdownPreview のまま（読み取り専用）
3. **自動保存**: body 変更時に 1秒デバウンスで `update_task` を呼び出す
4. **保存ステータス**: "Saving..." / "Saved" インジケータを表示
5. **タイトル編集**: インラインで編集可能にする
6. **タグ編集**: ActionBar にタグ入力欄を追加（Notes.tsx と同じパターン）

### 非機能要件

- MilkdownEditor コンポーネントは変更しない（既に再利用可能）
- Notes.tsx の自動保存パターンを踏襲し、一貫したUXを維持

## 設計

### ViewMode の変更

```typescript
// Before
type ViewMode = "list" | "preview";

// After
type ViewMode = "list" | "edit" | "preview";
```

- `edit`: アクティブタスク → MilkdownEditor
- `preview`: 完了済みタスク → MarkdownPreview（既存のまま）

### タスク詳細 (edit モード) の構成

```
┌─────────────────────────┐
│ [タイトル入力]           │  ← contenteditable or input
│ created: 04/15 10:00    │  ← 読み取り専用メタ
├─────────────────────────┤
│                         │
│   MilkdownEditor        │  ← body 編集
│                         │
├─────────────────────────┤
│ [Tags input] [✓][←][🗑] │  ← ActionBar
└─────────────────────────┘
         Saving... / Saved   ← ステータス
```

### 自動保存フロー

1. `body` or `tagsInput` or `editTitle` シグナル変更を検知
2. 1秒デバウンスで `update_task` を呼び出し
3. ステータスを `"saving"` → `"saved"` に更新

### 画面遷移

```
list ──(アクティブタスクをタップ)──→ edit
list ──(完了済みタスクをタップ)──→ preview
edit ──(← 戻る)──→ list
edit ──(✓ 完了)──→ list (タスクを完了して戻る)
preview ──(← 戻る)──→ list
```

## 実装ステップ

### Step 1: Tidy First — ViewMode 拡張 (構造変更のみ)

- `ViewMode` に `"edit"` を追加
- `openPreview` を分岐: アクティブ → `"edit"`, 完了 → `"preview"`
- この時点では edit モードの中身は空の placeholder でOK
- 既存テストが通ることを確認

### Step 2: edit モードに MilkdownEditor を配置 (機能変更)

- MilkdownEditor を import し edit モードの `<Match>` ブロックに配置
- `body` シグナルを追加し `onChange` で更新
- タイトル編集用の `editTitle` シグナルを追加
- タグ編集用の `tagsInput` シグナルを追加

### Step 3: デバウンス自動保存を実装

- Notes.tsx と同じパターンで `scheduleSave` / `save` を実装
- `save` は `update_task` を呼び出す
- `status` シグナルで保存状態を表示
- `onCleanup` でタイマーをクリア

### Step 4: ActionBar を更新

- edit モード: タグ入力 + 完了ボタン + 戻るボタン + 削除ボタン
- preview モード: 既存のまま

### Step 5: テスト・動作確認

- 既存のフロントエンドテストが通ることを確認
- 手動確認ポイント:
  - アクティブタスク → エディタで編集 → 自動保存される
  - 完了済みタスク → プレビュー表示のまま
  - 戻る → 一覧に反映されている
