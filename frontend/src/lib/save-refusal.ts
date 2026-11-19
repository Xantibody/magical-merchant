/**
 * What a refused save says. A pure function decided by only three things: which reason it
 * was refused for, whether the typed text was kept, and whether the keystrokes of the
 * refused note are on screen right now.
 *
 * It is kept apart from the screen because this decision is the exit of every failing save
 * path, the place with the most combinations. That way it can be checked as a table,
 * without building up to opening a note, typing, and making it refuse.
 */

import { isBrokenNoteSave, isMissingNoteSave, isNotTextNoteSave, isStaleSave } from "./commands";
import { t } from "./i18n";

/**
 * Whether the refusal is one a reload cannot fix. Three of them: a corrupt record, a
 * missing note, and a file that cannot be read as text. None leave any hope for the next
 * keystroke, so the typed text is set aside there and then. The decision sits in one place
 * because if a new reason were added and slipped past the set-aside path, the typed text
 * would vanish silently, left neither on disk nor in the copy.
 */
export const refusedForGood = (error: unknown): boolean =>
  isBrokenNoteSave(error) || isMissingNoteSave(error) || isNotTextNoteSave(error);

/**
 * What is on screen after a refused save. This decides what is said.
 *
 * - `draft`: the refused note is selected and the body is still what was typed. The only
 *   case where "copy it while it is still on screen" reaches the reader
 * - `reloaded`: that note is selected, but the body was replaced by a reload (the same
 *   whether it gave way or arrived back through A to B to A). The typed text is no longer
 *   on screen, so the only thing left to say is how to take it out of the copy
 * - `away`: another note is on screen. Advice pointing at the body on screen does not reach
 */
export type RefusedScreen = "draft" | "reloaded" | "away";

/**
 * What a refused save says. `screen` is whether the keystrokes of the refused note are on
 * screen right now. If they are not, advice pointing at the body on screen does not reach:
 * another note is on screen, and what would be copied is not there. Name the note first,
 * then say only where the copy is and whether it can be taken out.
 * The copies for a missing note and for a note that cannot be read as text do survive as
 * copies, but there is no way to take them out right now. Reopening does not load the body
 * because `read_note` is refused, so "restore" turns back there too.
 * Only Stale leaves the note in a writable state, so reopening it makes "restore" able to
 * take the text out. A reload runs only on the selected note, though, so for one that is
 * not on screen, say "reopen it first" before anything else. When the reload itself failed
 * (`draft`), the typed body is still on screen, so point at it and ask for it to be copied.
 * AIDEV-NOTE: there is no list that opens orphaned copies (those of missing or unreadable notes), so this only says honestly in words that they cannot be taken out (the way out is a separate PR)
 */
export function refusalToast(
  error: unknown,
  kept: boolean,
  title: string,
  screen: RefusedScreen,
): string {
  const words = t().notes;
  // Only while the keystrokes are still on screen does advice pointing at the body reach
  const onScreen = screen === "draft";
  if (!kept) {
    if (onScreen) {
      return words.saveNotKept;
    }
    // Where a reload landed, the body on screen was replaced by the one from disk.
    // There is no copy either, so the typed text is nowhere any more
    if (screen === "reloaded" && isStaleSave(error)) {
      return words.staleNotKept;
    }
    return words.saveNotKeptAway(title);
  }
  if (isStaleSave(error)) {
    if (screen === "reloaded") {
      return words.editedElsewhere;
    }
    return onScreen ? words.staleNotReloaded : words.editedElsewhereAway(title);
  }
  if (isMissingNoteSave(error)) {
    return onScreen ? words.missingNote : words.missingNoteAway(title);
  }
  // A file that cannot be read as text needs different care from a corrupt record.
  // What is fixed is the file itself, not the frontmatter, and reopening it is refused by
  // `read_note` for the same reason, so there is no way to take it out with "restore"
  if (isNotTextNoteSave(error)) {
    return onScreen ? words.notTextNote : words.notTextNoteAway(title);
  }
  if (isBrokenNoteSave(error)) {
    return onScreen ? words.brokenMeta : words.brokenMetaAway(title);
  }
  return words.saveFailedKept(title);
}
