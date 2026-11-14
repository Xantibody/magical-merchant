/**
 * Where the note panel stands: docked at the right edge of a wide window, risen from the foot
 * as a phone's sheet, or folded. Also what is open inside it: the details and which tab
 * shows.
 *
 * Kept apart from the view because the two presentations follow one rule that every entry
 * shares: a wide window docks the panel, a phone raises its sheet (`show`). Whether the
 * panel is docked belongs to the app (`shell.notePanelPinned`, like `shell.listTucked`), so it
 * comes in through the deps; the phone's sheet and the rest belong to the note on screen.
 */

import { batch, createEffect, createSignal, on } from "solid-js";
import type { Accessor, Setter } from "solid-js";
import type { NotePanelTab } from "../components/NotePanel";

export interface NotePanelDeps {
  /** Whether the width has list and detail side by side. Only there is the panel docked. */
  twoPane: Accessor<boolean>;
  /** Whether the writing screen is up. Nothing interrupts the writing hand. */
  writing: Accessor<boolean>;
  /** Whether compare mode is on. The history tab is compare mode itself. */
  historyOpen: Accessor<boolean>;
  /** Whether the panel is docked beside the body. The app's, not the note's. */
  pinned: Accessor<boolean>;
  setPinned: (pinned: boolean) => void;
  leaveHistory: () => void;
}

export interface NotePanelState {
  /** Puts the phone's panel screen up or takes it down. */
  setScreen: Setter<boolean>;
  /** Whether the panel's sheet is up on a phone, over the note. */
  screenShown: () => boolean;
  /** Whether the right panel is on screen in a wide window. */
  open: () => boolean;
  /** Which tab the panel shows. The history tab is compare mode itself. */
  tab: () => NotePanelTab;
  /** Whether the panel's details (created, updated, surroundings) are unfolded. */
  detailsOpen: Accessor<boolean>;
  setDetailsOpen: Setter<boolean>;
  /** Puts the panel up: docked in a wide window, as its own screen on a phone. */
  show: () => void;
  /**
   * Folds the panel entirely, compare mode included. Opening it again always starts on the
   * settings tab, so a panel that appears never starts by comparing.
   */
  close: () => void;
  /** ⌘. and the strip's …. Opens the panel, or folds it. On a phone, the panel screen. */
  toggle: () => void;
}

export function createNotePanel(deps: NotePanelDeps): NotePanelState {
  /**
   * Whether the panel's sheet is up on a phone. There is no width to lay it alongside, so it
   * rises from the foot over the note. Pressing a version sinks the sheet to its first stop,
   * which then reads as the compare line.
   */
  const [screen, setScreen] = createSignal(false);
  const [detailsOpen, setDetailsOpen] = createSignal(false);

  const show = (): void => {
    if (deps.twoPane()) {
      deps.setPinned(true);
    } else {
      setScreen(true);
    }
  };

  const close = (): void => {
    batch(() => {
      deps.leaveHistory();
      deps.setPinned(false);
      setScreen(false);
    });
  };

  const toggle = (): void => {
    if (deps.writing()) {
      return;
    }
    if (!deps.twoPane()) {
      setScreen((open) => !open);
      return;
    }
    if (deps.pinned()) {
      close();
      return;
    }
    show();
  };

  // Whatever way the writing screen was reached, the panel does not stay beside it
  createEffect(
    on(deps.writing, (entered) => {
      if (entered) {
        close();
      }
    }),
  );

  return {
    setScreen,
    screenShown: () => screen() && !deps.twoPane(),
    open: () => deps.twoPane() && deps.pinned(),
    tab: () => (deps.historyOpen() ? "history" : "note"),
    detailsOpen,
    setDetailsOpen,
    show,
    close,
    toggle,
  };
}
