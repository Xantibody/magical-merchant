/**
 * The template screen's variable list: which field a variable goes into, the list opened from
 * the insert button or by typing `{{`, and putting the one picked where the caret was.
 *
 * The fields themselves stay with the screen. This only reads their elements for the caret and
 * hands the new value back, so what a write means (whether it counts as an edit) is the
 * screen's to say.
 */

import { batch, createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import { isImeComposing } from "./ime";
import { TEMPLATE_VARS } from "./template-vars";

/** Where a variable chip is inserted. These three fields are the ones that take `{{...}}`. */
export type VarField = "title" | "body" | "tag";

interface VarMenuDeps {
  /** The element of a field, where the caret is read and put back. */
  input: (field: VarField) => HTMLInputElement | HTMLTextAreaElement | undefined;
  /** A field's value once a variable has gone into it. */
  write: (field: VarField, value: string) => void;
}

export interface VarMenu {
  /** The field touched last. If a chip is pressed right after opening, it goes in the body. */
  field: Accessor<VarField>;
  setField: (field: VarField) => void;
  /**
   * The list of variables: opened from the insert button ("vars"), or by typing `{{` in the
   * body ("auto"), in which case the braces typed are replaced by the one picked.
   */
  opened: Accessor<"vars" | "auto" | null>;
  /** The row of the list the arrow keys and the pointer are on. */
  index: Accessor<number>;
  setIndex: (at: number) => void;
  close: () => void;
  /** The insert button: opens the list on its first row, or closes it. */
  toggle: () => void;
  /**
   * Insert a variable where the cursor is. The target is the field touched last: were it
   * always the body, there would be no way to put a variable in the title or a tag. Focus
   * returns to that field after the press.
   */
  insert: (token: string) => void;
  /**
   * The keys of an open variable list, taken before the field sees them. Returns whether the
   * key was the list's.
   */
  keys: (e: KeyboardEvent) => boolean;
  /** The body after an input, with where its caret now stands. */
  bodyTyped: (value: string, caret: number) => void;
  /** The body lost the focus: the list its `{{` opened goes too. The insert button's stays. */
  closeAuto: () => void;
}

export function createVarMenu(deps: VarMenuDeps): VarMenu {
  const [field, setField] = createSignal<VarField>("body");
  const [opened, setOpened] = createSignal<"vars" | "auto" | null>(null);
  const [index, setIndex] = createSignal(0);
  /** Where the caret stood right after the `{{` that opened the "auto" list. */
  let autoAt = 0;

  const insert = (token: string): void => {
    const target = field();
    const el = deps.input(target);
    if (!el) {
      return;
    }
    // Picked from the list the typed `{{` opened: the braces become the variable
    const replacing = opened() === "auto" && target === "body";
    setOpened(null);
    const start = replacing ? autoAt - 2 : (el.selectionStart ?? el.value.length);
    const end = replacing ? autoAt : (el.selectionEnd ?? start);
    deps.write(target, `${el.value.slice(0, start)}${token}${el.value.slice(end)}`);

    const caret = start + token.length;
    queueMicrotask(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const keys = (e: KeyboardEvent): boolean => {
    if (opened() === null) {
      return false;
    }
    const count = TEMPLATE_VARS.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setIndex((at) => (at + step + count) % count);
      return true;
    }
    // The Enter that commits a conversion belongs to the IME (#102)
    if (e.key === "Enter" && !isImeComposing(e)) {
      e.preventDefault();
      const picked = TEMPLATE_VARS[index()];
      if (picked) {
        insert(picked.token);
      }
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setOpened(null);
      return true;
    }
    return false;
  };

  return {
    field,
    setField: (next) => setField(next),
    opened,
    index,
    setIndex: (at) => setIndex(at),
    close: () => setOpened(null),
    toggle: () => {
      batch(() => {
        setIndex(0);
        setOpened(opened() === "vars" ? null : "vars");
      });
    },
    insert,
    keys,
    bodyTyped: (value, caret) => {
      // `{{` right before the caret opens the list; typing on past it closes it
      if (value.slice(caret - 2, caret) === "{{") {
        autoAt = caret;
        batch(() => {
          setIndex(0);
          setOpened("auto");
        });
      } else if (opened() === "auto") {
        setOpened(null);
      }
    },
    closeAuto: () => {
      if (opened() === "auto") {
        setOpened(null);
      }
    },
  };
}
