import { createResource, Show } from "solid-js";
import type { JSX } from "solid-js";
import Drawer from "corvu/drawer";
import Icon from "./Icon";
import MarkdownPreview from "./MarkdownPreview";
import { typedInvoke } from "../lib/commands";
import { glyphs } from "../lib/glyphs";
import { t } from "../lib/i18n";
import { splitTitle } from "../lib/note-title";

interface LinkPeekProps {
  filename: string;
  /** The title the list knows; the note's own heading takes over once it is read. */
  title?: string;
  /** A phone lifts it as a sheet a finger can pull up into the note itself. */
  sheet: boolean;
  noteTitles: ReadonlyMap<string, string>;
  /** Open it for real, in place of the note being read. */
  onOpen: () => void;
  onClose: () => void;
}

/** Where the phone's peek stops: most of the screen, and all of it (which opens the note). */
const PEEK_POINTS: number[] = [0, 0.62, 1];

/**
 * A `[[link]]`'s note lifted over the one being read (88), so following a reference does not
 * lose the place: read it and let it drop back, or open it for real. On a phone it is a sheet;
 * pulled all the way up it simply becomes the note, the same as pressing "open". On a wide window
 * it is a sheet lying at the page's right edge, where the note panel lies, and the body yields that
 * room: a card over the text, wherever it stood, hid lines next to the one being read.
 *
 * Read-only and read once: nothing here writes, so it needs no revision of its own.
 */
export default function LinkPeek(props: LinkPeekProps): JSX.Element {
  const [note] = createResource(
    () => props.filename,
    async (filename) => {
      try {
        const read = await typedInvoke("read_note", { filename });
        return splitTitle(read.body);
      } catch {
        return null;
      }
    },
  );

  const title = (): string => note()?.title || props.title || t().notes.untitled;

  const body = (): JSX.Element => (
    <>
      <div class="link-peek-head">
        <span class="link-peek-title">{title()}</span>
        <button
          type="button"
          class="button-secondary link-peek-open"
          onClick={() => props.onOpen()}
        >
          <Icon name="arrow-square-out" size={14} />
          {t().palm.peekOpen}
        </button>
        <button
          type="button"
          class="icon-button"
          aria-label={t().palm.peekClose}
          onClick={() => props.onClose()}
        >
          <Icon name="x" size={16} />
        </button>
      </div>
      <div class="link-peek-body">
        <Show
          when={note() !== null}
          fallback={<p class="link-peek-missing">{t().palm.peekMissing}</p>}
        >
          <MarkdownPreview
            source={note()?.body ?? ""}
            noteTitles={props.noteTitles}
            glyphs={glyphs()}
          />
        </Show>
      </div>
    </>
  );

  return (
    <Show
      when={props.sheet}
      fallback={
        <aside class="link-peek-card" aria-label={title()}>
          {body()}
        </aside>
      }
    >
      <Drawer
        open
        onOpenChange={(open) => {
          if (!open) {
            props.onClose();
          }
        }}
        snapPoints={PEEK_POINTS}
        defaultSnapPoint={0.62}
        onActiveSnapPointChange={(point) => {
          // Pulled all the way up, the peek has become the note
          if (point === 1) {
            props.onOpen();
          }
        }}
        modal={false}
        trapFocus={false}
        preventScroll={false}
        restoreFocus={false}
      >
        <Drawer.Content class="note-sheet link-peek-sheet" aria-label={title()}>
          <div class="note-sheet-grip" aria-hidden="true" />
          {body()}
        </Drawer.Content>
      </Drawer>
    </Show>
  );
}
