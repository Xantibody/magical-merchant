/**
 * A note's view mode. The conversion to and from the frontmatter `view` key is kept in
 * one place.
 *
 * The key is promised to mean something only when it is written. Writing out the default
 * editor view would rewrite the frontmatter of notes that were never switched, which
 * counts as a changed content hash, and sync would send unchanged notes again.
 */

export type NoteView = "editor" | "mindmap" | "preview";

/** Resolve the frontmatter `view` value to a view mode. An unknown value falls to the editor. */
export function resolveNoteView(view?: string): NoteView {
  return view === "mindmap" || view === "preview" ? view : "editor";
}

/** The value written to the frontmatter. The default editor view drops the key (null). */
export function viewToFrontmatter(view: NoteView): string | null {
  return view === "editor" ? null : view;
}

export interface NoteContent {
  body: string;
  view: NoteView;
  /** The body's revision at the moment it was read. Attached to the save. */
  revision: string;
}

/**
 * Read the body and the view mode as a pair. Sent to the screen separately, the body that
 * arrives first is drawn for an instant in the wrong mode (a mindmap note flashes as
 * Markdown before it is replaced). A failed meta read falls back to the default editor
 * view, but a failed body read is not papered over: showing an empty note does more harm.
 */
export async function readNoteContent(
  readBody: () => Promise<{ body: string; revision: string }>,
  readMeta: () => Promise<{ view?: string }>,
): Promise<NoteContent> {
  const [{ body, revision }, view] = await Promise.all([
    readBody(),
    readMeta().then(
      (meta) => resolveNoteView(meta.view),
      () => "editor" as const,
    ),
  ]);
  return { body, view, revision };
}
