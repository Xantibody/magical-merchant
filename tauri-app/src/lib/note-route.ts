/**
 * The URL that opens one note. Note and Codex live on different surfaces, so an ID
 * alone on `/notes?file=` leaves a Codex absent from the screen it opens. Every
 * opening path (palette, widget, backlink, chip) goes through here, so that one
 * more surface does not mean a branch in each path.
 */

import type { NoteKind } from "./commands";
import { ROUTES } from "./routes";

export function noteRoute(kind: NoteKind, filename?: string): string {
  const base = kind === "codex" ? ROUTES.CODEX : ROUTES.NOTES;
  return filename ? `${base}?file=${encodeURIComponent(filename)}` : base;
}
