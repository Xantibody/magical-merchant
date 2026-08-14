import { invoke } from "@tauri-apps/api/core";
import type { ClientContext } from "./client-context";

export interface Note {
  path: string;
  filename: string;
  time?: string;
  tags: string[];
  preview: string;
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
  read_timeline: { args: void; result: string[] };
  list_timeline_dates: { args: void; result: string[] };
  read_timeline_by_date: { args: { date: string }; result: string[] };
  update_timeline_entry: { args: { date: string; index: number; text: string }; result: void };
  delete_timeline_entry: { args: { date: string; index: number }; result: void };
  search_all: { args: { query: string }; result: SearchHit[] };
  create_draft: { args: { body: string; tags: string[] } & ClientArgs; result: string };
  update_draft: {
    args: { filePath: string; body: string } & ClientArgs;
    result: void;
  };
  list_notes: { args: void; result: Note[] };
  read_note: { args: { filename: string }; result: string };
  read_note_meta: { args: { filename: string }; result: NoteMeta };
  update_note_meta: { args: { filename: string; time: string; tags: string[] }; result: void };
  delete_note: { args: { filename: string }; result: void };
  save_document: { args: { body: string; tags: string[] } & ClientArgs; result: void };
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

/** ノート/タイムラインのファイルを書き換えるコマンド。 */
const MUTATING: ReadonlySet<CommandName> = new Set<CommandName>([
  "save_quick_capture",
  "update_timeline_entry",
  "delete_timeline_entry",
  "create_draft",
  "update_draft",
  "update_note_meta",
  "delete_note",
  "save_document",
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
