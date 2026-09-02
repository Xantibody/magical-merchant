import { invoke } from "@tauri-apps/api/core";
import type { ClientContext } from "./client-context";

export interface Note {
  path: string;
  filename: string;
  time?: string;
  tags: string[];
  preview: string;
  /** 昇格元エントリの日時(`YYYY-MM-DDTHH:MM:SS`)。エントリ由来のノートだけ持つ。 */
  origin?: string;
  /** 生まれ元のテンプレ名。テンプレから作ったノートだけ持つ。 */
  template?: string;
}

/** テンプレ一覧の 1 件。 */
export interface Template {
  filename: string;
  /** 拡張子を落とした名前。画面に出す名前でもある。 */
  name: string;
  tags: string[];
  /** 本文の先頭行。変数は解決されていない。 */
  preview: string;
}

/** テンプレ 1 件の中身。本文と自動タグは編集画面が同時に描く。 */
interface TemplateDetail {
  /** 変数を解決していない、書かれたままの本文。 */
  body: string;
  tags: string[];
}

/** 登録済みグリフ(特殊文字画像)一覧の 1 件。画像そのものは持たない。 */
export interface GlyphSummary {
  name: string;
  filename: string;
  /** `png` か `svg`。 */
  format: string;
  bytes: number;
}

/** `:name:` を描くための 1 件。`url` はデータ URL。 */
interface GlyphAsset {
  name: string;
  url: string;
}

/** テンプレ起動の結果。 */
interface CreatedNote {
  path: string;
  /** 今日のぶんが既にあったので、作らずにそれを開いた。 */
  reused: boolean;
}

/**
 * 記録時の端末情報。core の `Context` は空のフィールドを省いて
 * シリアライズするので、全部が省略可能。
 */
export interface NoteContext {
  battery?: number;
  is_charging?: boolean;
  network_type?: string;
  location?: { latitude: number; longitude: number };
  os?: string;
  os_version?: string;
  arch?: string;
  hostname?: string;
  locale?: string;
}

/** 1 件ぶんの frontmatter。`time` はオフセット付き RFC 3339。 */
interface NoteMeta {
  time: string;
  tags: string[];
  context?: NoteContext;
  /** 表示モード。`"mindmap"` 以外の値の解釈は `note-view.ts` に寄せてある。 */
  view?: string;
  /** 本文を最後に書き直した時刻。一度も編集していないノートは持たない。 */
  updated?: string;
}

type HitKind = "timeline" | "note";

export interface SearchHit {
  kind: HitKind;
  title: string;
  snippet: string;
  date: string;
  filename: string | null;
  index: number | null;
  tags: string[];
  /** `snippet` 内の一致開始位置(文字数)。タグだけに当たったときは無い。 */
  match_start?: number | null;
  /** 一致の長さ(文字数)。`match_start` と対。 */
  match_len?: number | null;
}

interface SyncConfig {
  workers_url: string;
  auto_sync: boolean;
}

/** 記録時の実行環境。ネイティブから見えないぶんを WebView 側が埋めて渡す。 */
interface ClientArgs {
  client: ClientContext;
}

interface CommandMap {
  save_quick_capture: { args: { text: string } & ClientArgs; result: void };
  list_timeline_dates: { args: void; result: string[] };
  read_timeline_by_date: { args: { date: string }; result: string[] };
  delete_timeline_entry: { args: { date: string; index: number }; result: void };
  /**
   * `tags` は範囲。全部を持つ記録だけが返り、query が空でも tags があれば
   * そのタグの付いた記録を全部返す。
   */
  search_all: { args: { query: string; tags: string[] }; result: SearchHit[] };
  /** このノートを `[[ID]]` で指している記録。開くたびに走査で導出される。 */
  find_backlinks: { args: { filename: string }; result: SearchHit[] };
  /**
   * 座標 → 地名。引けたものだけが `["緯度,経度", 地名]` で返る。
   * `locale` は OS のジオコーダに渡す言語(`ja` / `en`)。
   */
  resolve_places: {
    args: { coordinates: [number, number][]; locale: string };
    result: [string, string][];
  };
  create_draft: {
    args: { body: string; tags: string[]; origin?: string } & ClientArgs;
    result: string;
  };
  update_draft: {
    args: { filePath: string; body: string } & ClientArgs;
    result: void;
  };
  list_notes: { args: void; result: Note[] };
  read_note: { args: { filename: string }; result: string };
  read_note_meta: { args: { filename: string }; result: NoteMeta };
  update_note_meta: { args: { filename: string; time: string; tags: string[] }; result: void };
  set_note_view: { args: { filename: string; view: string | null }; result: void };
  /** 昇格元エントリとの繋がりを書き換える。`null` で関係を解く。 */
  set_note_origin: { args: { filename: string; origin: string | null }; result: void };
  delete_note: { args: { filename: string }; result: void };
  list_templates: { args: void; result: Template[] };
  read_template: { args: { filename: string }; result: TemplateDetail };
  save_template: { args: { filename: string; body: string; tags: string[] }; result: void };
  delete_template: { args: { filename: string }; result: void };
  /**
   * テンプレからノートを作る。`locale` は `{{weekday}}` のため —
   * 曜日の呼び名だけは端末の言語に従う。
   */
  create_from_template: {
    args: { filename: string; locale: string } & ClientArgs;
    result: CreatedNote;
  };
  list_glyphs: { args: void; result: GlyphSummary[] };
  /** 登録済みグリフを全部データ URL で。本文を描く前に 1 回引いておく。 */
  read_glyphs: { args: void; result: GlyphAsset[] };
  /** `format` は `png` か `svg`。中身は base64。 */
  save_glyph: { args: { name: string; format: string; dataBase64: string }; result: void };
  delete_glyph: { args: { name: string }; result: void };
  sync_start: { args: void; result: void };
  sync_status: { args: void; result: unknown };
  auth_login: { args: void; result: void };
  auth_status: { args: void; result: boolean };
  auth_logout: { args: void; result: void };
  get_sync_config: { args: void; result: SyncConfig };
  save_sync_config: { args: { config: SyncConfig }; result: void };
  is_sync_config_editable: { args: void; result: boolean };
}

export type CommandName = keyof CommandMap;

/** `data/` の下のファイルを書き換えるコマンド。同期の合図になる。 */
const MUTATING: ReadonlySet<CommandName> = new Set<CommandName>([
  "save_quick_capture",
  "delete_timeline_entry",
  "create_draft",
  "update_draft",
  "update_note_meta",
  "set_note_view",
  "set_note_origin",
  "delete_note",
  "save_template",
  "delete_template",
  "create_from_template",
  "save_glyph",
  "delete_glyph",
]);

const mutationListeners = new Set<() => void>();

/**
 * 書き込みコマンドが成功するたびに呼ばれる。
 * 呼び出し側ごとに通知を書くと必ずどこかで漏れるので、ここ一箇所に寄せる。
 */
export function onLocalMutation(listener: () => void): () => void {
  mutationListeners.add(listener);
  return () => mutationListeners.delete(listener);
}

export function typedInvoke<K extends CommandName>(
  cmd: K,
  ...args: CommandMap[K]["args"] extends void ? [] : [CommandMap[K]["args"]]
): Promise<CommandMap[K]["result"]> {
  const call =
    args.length === 0
      ? invoke<CommandMap[K]["result"]>(cmd)
      : invoke<CommandMap[K]["result"]>(cmd, args[0] as Record<string, unknown>);

  if (!MUTATING.has(cmd)) {
    return call;
  }
  return call.then((result) => {
    for (const listener of mutationListeners) {
      listener();
    }
    return result;
  });
}
