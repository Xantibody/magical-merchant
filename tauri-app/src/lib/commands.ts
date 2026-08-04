import { invoke } from "@tauri-apps/api/core";

export interface Note {
  path: string;
  filename: string;
  time?: string;
  tags: string[];
  preview: string;
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

interface LocationArgs {
  latitude: number | null;
  longitude: number | null;
}

interface CommandMap {
  save_quick_capture: { args: { text: string } & LocationArgs; result: void };
  read_timeline: { args: void; result: string[] };
  list_timeline_dates: { args: void; result: string[] };
  read_timeline_by_date: { args: { date: string }; result: string[] };
  update_timeline_entry: { args: { date: string; index: number; text: string }; result: void };
  delete_timeline_entry: { args: { date: string; index: number }; result: void };
  search_all: { args: { query: string }; result: SearchHit[] };
  create_draft: { args: { body: string; tags: string[] } & LocationArgs; result: string };
  update_draft: {
    args: { filePath: string; body: string; tags: string[] } & LocationArgs;
    result: void;
  };
  list_notes: { args: void; result: Note[] };
  read_note: { args: { filename: string }; result: string };
  delete_note: { args: { filename: string }; result: void };
  save_document: { args: { body: string; tags: string[] } & LocationArgs; result: void };
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
