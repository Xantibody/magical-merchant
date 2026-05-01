import { invoke } from "@tauri-apps/api/core";

export interface Note {
  path: string;
  filename: string;
  time?: string;
  tags: string[];
  preview: string;
}

export interface Project {
  slug: string;
  name: string;
  description: string;
}

export interface Task {
  filename: string;
  title: string;
  created: string;
  completed?: string;
  tags: string[];
  body: string;
}

export interface SyncConfig {
  workers_url: string;
}

interface LocationArgs {
  latitude: number | null;
  longitude: number | null;
}

type CommandMap = {
  save_quick_capture: { args: { text: string } & LocationArgs; result: void };
  read_timeline: { args: void; result: string[] };
  list_timeline_dates: { args: void; result: string[] };
  read_timeline_by_date: { args: { date: string }; result: string[] };
  create_draft: { args: { body: string; tags: string[] } & LocationArgs; result: string };
  update_draft: {
    args: { filePath: string; body: string; tags: string[] } & LocationArgs;
    result: void;
  };
  list_notes: { args: void; result: Note[] };
  read_note: { args: { filename: string }; result: string };
  delete_note: { args: { filename: string }; result: void };
  save_document: { args: { body: string; tags: string[] } & LocationArgs; result: void };
  create_project: {
    args: { slug: string; name: string; description: string };
    result: string;
  };
  list_projects: { args: void; result: Project[] };
  create_task: {
    args: { projectSlug: string; title: string; tags: string[]; body: string };
    result: string;
  };
  list_active_tasks: { args: { projectSlug: string }; result: Task[] };
  list_done_tasks: { args: { projectSlug: string }; result: Task[] };
  complete_task: { args: { projectSlug: string; filename: string }; result: void };
  update_task: {
    args: {
      projectSlug: string;
      filename: string;
      title: string;
      tags: string[];
      body: string;
    };
    result: void;
  };
  delete_task: { args: { projectSlug: string; filename: string }; result: void };
  sync_start: { args: void; result: void };
  sync_status: { args: void; result: unknown };
  auth_login: { args: void; result: void };
  auth_status: { args: void; result: boolean };
  auth_logout: { args: void; result: void };
  get_sync_config: { args: void; result: SyncConfig };
};

export type CommandName = keyof CommandMap;

export async function typedInvoke<K extends CommandName>(
  cmd: K,
  ...args: CommandMap[K]["args"] extends void ? [] : [CommandMap[K]["args"]]
): Promise<CommandMap[K]["result"]> {
  if (args.length === 0) {
    return invoke<CommandMap[K]["result"]>(cmd);
  }

  return invoke<CommandMap[K]["result"]>(cmd, args[0] as Record<string, unknown>);
}
