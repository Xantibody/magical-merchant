import { invoke } from "@tauri-apps/api/core";
import type { ClientContext } from "./client-context";

/** Which surface it lives on. `codex` is a document that keeps growing and commits versions. Decided by where it is stored (the directory). */
export type NoteKind = "note" | "codex";

export interface Note {
  kind: NoteKind;
  path: string;
  filename: string;
  time?: string;
  tags: string[];
  preview: string;
  /** Time of the entry it was promoted from (`YYYY-MM-DDTHH:MM:SS`). Only notes born from an entry have it. */
  origin?: string;
  /** Name of the template it was born from. Only notes made from a template have it. */
  template?: string;
  /** Display mode from the frontmatter. The list uses it to show the read-only mark. */
  view?: string;
  /** Number of committed versions. Only Codex rows have it. */
  version_count?: number;
  /** Whether the draft has moved on from the latest version. Codex rows only. */
  dirty?: boolean;
}

/** One Codex version. `id` is passed as is to read / diff / restore. */
export interface Version {
  id: string;
  /** When it was committed. RFC 3339 with an offset. */
  time: string;
  /** The line the committer attached. null when there is none. */
  message: string | null;
  /** Byte count of the body. Used to show the difference from the neighbouring version. */
  bytes: number;
}

/** The number of versions, and how far the draft has moved from the latest one. */
export interface VersionStatus {
  count: number;
  dirty: boolean;
  /** Draft byte count minus the latest version's. 0 when there is no version. */
  bytes_delta: number;
}

interface NoteRead {
  body: string;
  /** Fingerprint of the body. Attached to `update_draft` so we never write over an outside change. */
  revision: string;
}

/**
 * Failure of `update_draft`. `stale` means "someone rewrote it after the read",
 * `broken` means "core refused because the record at the head of the note cannot be read",
 * `missing` means "core refused because the note no longer exists",
 * `notText` means "core refused because the file's content cannot be read as text".
 */
interface SaveError {
  kind: "stale" | "broken" | "missing" | "notText" | "other";
  message: string;
}

function saveErrorKind(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "kind" in error
    ? (error as SaveError).kind
    : undefined;
}

export function isStaleSave(error: unknown): boolean {
  return saveErrorKind(error) === "stale";
}

/**
 * A note whose record is broken, so it cannot be written. Unlike Stale, rereading
 * does not fix it, so the caller sets the typed text aside and tells the person.
 */
export function isBrokenNoteSave(error: unknown): boolean {
  return saveErrorKind(error) === "broken";
}

/**
 * The note being saved to no longer exists. It was deleted after it was opened,
 * or it moved to Codex. core does not recreate the note here, so like `broken`
 * a reread does not fix it: the caller sets the typed text aside and tells the person.
 */
export function isMissingNoteSave(error: unknown): boolean {
  return saveErrorKind(error) === "missing";
}

/**
 * The file being saved to cannot be read as text (invalid UTF-8). It is bytes
 * left behind by sync or an outside tool, and like `broken` a reread does not
 * fix it: the caller sets the typed text aside and tells the person.
 *
 * It is kept apart from `broken` because the message differs. What is broken is
 * not the record at the head but the file itself, and `read_note` is refused for
 * the same reason. So there is no path of reopening and putting the backup on
 * screen with "Revert"; guiding that far would be a lie.
 */
export function isNotTextNoteSave(error: unknown): boolean {
  return saveErrorKind(error) === "notText";
}

/** One row of the template list. */
export interface Template {
  filename: string;
  /** Name without the extension. Also the name shown on screen. */
  name: string;
  tags: string[];
  /** First line of the body. Variables are not resolved; the list resolves them for today. */
  preview: string;
}

/** Contents of one template. The edit screen draws the body and the automatic tags together. */
interface TemplateDetail {
  /** The body as written, variables unresolved. */
  body: string;
  tags: string[];
}

/** One row of the registered glyph (special character image) list. It does not carry the image. */
export interface GlyphSummary {
  name: string;
  filename: string;
  /** `png` or `svg`. */
  format: string;
  bytes: number;
}

/** One entry for drawing `:name:`. `url` is a data URL. */
interface GlyphAsset {
  name: string;
  url: string;
}

/** Result of launching a template. */
interface CreatedNote {
  path: string;
  /** Today's already existed, so it was opened instead of created. */
  reused: boolean;
}

/**
 * Device information at record time. core's `Context` skips empty fields when
 * it serializes, so everything is optional.
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

/** frontmatter of one record. `time` is RFC 3339 with an offset. */
export interface NoteMeta {
  time: string;
  tags: string[];
  context?: NoteContext;
  /** Display mode. Interpreting values other than `"mindmap"` is gathered in `note-view.ts`. */
  view?: string;
  /** When the body was last rewritten. A note never edited does not have it. */
  updated?: string;
  /**
   * The tool that created it (`app` / `cli` / `mcp` / `widget`). It records the
   * creation, so editing with another tool does not change it. Notes written
   * before tools named themselves do not have it.
   */
  source?: string;
}

export type HitKind = "scrawl" | NoteKind;

export interface SearchHit {
  kind: HitKind;
  title: string;
  snippet: string;
  date: string;
  filename: string | null;
  index: number | null;
  tags: string[];
  /** Start of the match inside `snippet` (in characters). Absent when only a tag matched. */
  match_start?: number | null;
  /** Length of the match (in characters). Pairs with `match_start`. */
  match_len?: number | null;
}

interface SyncConfig {
  workers_url: string;
  auto_sync: boolean;
}

/** Runtime environment at record time. The WebView fills in what the native side cannot see. */
interface ClientArgs {
  client: ClientContext;
}

interface CommandMap {
  save_quick_capture: { args: { text: string } & ClientArgs; result: void };
  list_scrawl_dates: { args: void; result: string[] };
  read_scrawl_by_date: { args: { date: string }; result: string[] };
  /** `raw` is the line as the screen read it. The index alone drifts when an append lands after the read. */
  delete_scrawl_entry: { args: { date: string; index: number; raw: string }; result: void };
  /**
   * `tags` is a scope. Only records carrying all of them come back; with an empty
   * query and tags set, every record with those tags is returned.
   */
  search_all: { args: { query: string; tags: string[] }; result: SearchHit[] };
  /**
   * Every record. It does not filter by string, so it has no arguments and the
   * count is not capped: the counts on the chips are taken from here.
   * `match_start` / `match_len` are always `null`.
   */
  browse_all: { args: void; result: SearchHit[] };
  /** Records that point at this note with `[[ID]]`. Derived by a scan every time the note is opened. */
  find_backlinks: { args: { filename: string }; result: SearchHit[] };
  /**
   * Coordinates to place names. Only those that resolved come back, as
   * `["lat,lon", name]`. `locale` is the language passed to the OS geocoder (`ja` / `en`).
   */
  resolve_places: {
    args: { coordinates: [number, number][]; locale: string };
    result: [string, string][];
  };
  create_draft: {
    args: { body: string; tags: string[]; origin?: string; kind?: NoteKind } & ClientArgs;
    result: string;
  };
  /**
   * `revision` is the fingerprint of the body `read_note` returned. When it is
   * attached and the CLI or MCP rewrote the same note in between, the call is
   * refused with `kind: "stale"`. Returns the revision of the body written.
   */
  update_draft: {
    args: { filename: string; body: string; revision?: string | null } & ClientArgs;
    result: string;
  };
  list_notes: { args: void; result: Note[] };
  read_note: { args: { filename: string }; result: NoteRead };
  read_note_meta: { args: { filename: string }; result: NoteMeta };
  update_note_meta: { args: { filename: string; time: string; tags: string[] }; result: void };
  set_note_view: { args: { filename: string; view: string | null }; result: void };
  /** Rewrites the link to the entry it was promoted from. `null` cuts the tie. */
  set_note_origin: { args: { filename: string; origin: string | null }; result: void };
  delete_note: { args: { filename: string }; result: void };
  /** Moves a Note into the Codex directory. The ID does not change. Does nothing if it is already a Codex. */
  promote_note_to_codex: { args: { filename: string }; result: void };
  // ---- Codex versions. Each works only on a Codex; called on a Note it is refused with `kind: "other"` ----
  /** Commits the current draft as a version. Only when a person presses it. Never called automatically. */
  commit_note_version: { args: { filename: string; message?: string | null }; result: Version };
  /** Newest first. */
  list_note_versions: { args: { filename: string }; result: Version[] };
  /** Body of the version only. No frontmatter. */
  read_note_version: { args: { filename: string; id: string }; result: string };
  /**
   * Unified diff from version `from` to the current draft. Empty string when they
   * are the same. The header is `--- <from>` / `+++ draft`.
   */
  diff_note_versions: { args: { filename: string; from: string }; result: string };
  /**
   * Makes the version's body the draft. The current draft is committed first as
   * "before restore". `revision` is checked as in `update_draft`, and the new revision is returned.
   */
  restore_note_version: {
    args: { filename: string; id: string; revision?: string | null } & ClientArgs;
    result: string;
  };
  /** Called only by the "undo" right after a commit. Deletes the version file and never touches the body. */
  delete_note_version: { args: { filename: string; id: string }; result: void };
  note_version_status: { args: { filename: string }; result: VersionStatus };
  list_templates: { args: void; result: Template[] };
  read_template: { args: { filename: string }; result: TemplateDetail };
  save_template: { args: { filename: string; body: string; tags: string[] }; result: void };
  delete_template: { args: { filename: string }; result: void };
  /**
   * Creates a note from a template. `locale` is for `{{weekday}}`:
   * only the weekday's name follows the device language.
   */
  create_from_template: {
    args: { filename: string; locale: string } & ClientArgs;
    result: CreatedNote;
  };
  list_glyphs: { args: void; result: GlyphSummary[] };
  /** Every registered glyph as a data URL. Fetched once before the body is drawn. */
  read_glyphs: { args: void; result: GlyphAsset[] };
  /** `format` is `png` or `svg`. The content is base64. */
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
  /**
   * Exports a diagram. Shows the save dialog and writes where the person chose.
   * It does not touch notes, so it is not in MUTATING. `saved: false` is a cancel.
   */
  save_export: { args: { suggestedName: string; dataBase64: string }; result: { saved: boolean } };
}

export type CommandName = keyof CommandMap;

/** Commands that rewrite files under `data/`. They signal a sync. */
const MUTATING: ReadonlySet<CommandName> = new Set<CommandName>([
  "save_quick_capture",
  "delete_scrawl_entry",
  "create_draft",
  "update_draft",
  "update_note_meta",
  "set_note_view",
  "set_note_origin",
  "delete_note",
  "promote_note_to_codex",
  "commit_note_version",
  "restore_note_version",
  "delete_note_version",
  "save_template",
  "delete_template",
  "create_from_template",
  "save_glyph",
  "delete_glyph",
]);

const mutationListeners = new Set<() => void>();

/**
 * Called every time a writing command succeeds.
 * Writing the notification at each call site always leaks somewhere, so it is gathered here.
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
