/**
 * The "Vim keys in the editor" setting. Off unless someone turns it on: a modal
 * editor is a special way to work, and the app must take text the moment it opens.
 *
 * Kept in localStorage like the fullscreen setting (`fullscreen.ts`). The editor
 * reads it once when it is built, so a change applies from the next note opened.
 */

const STORAGE_KEY = "vim-keys";

export function readVimEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "true";
}

export function writeVimEnabled(on: boolean): void {
  localStorage.setItem(STORAGE_KEY, String(on));
}
