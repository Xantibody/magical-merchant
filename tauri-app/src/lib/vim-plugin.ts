import { $prose } from "@milkdown/kit/utils";
import { NodeSelection, Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { EditorState, Selection, Transaction } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";
import { redo, undo } from "@milkdown/kit/prose/history";
import { isImeComposing } from "./ime";
import { interpretKey, keyOf } from "./vim-keys";
import type { VimAction, VimMode } from "./vim-keys";
import {
  caretAt,
  charAfter,
  charBefore,
  charRegister,
  clampToLine,
  deleteChar,
  deleteLine,
  deleteVisual,
  insertPosition,
  lineAt,
  motionTarget,
  openLine,
  put,
  visualRegister,
  visualSelection,
  yankLine,
} from "./vim-commands";
import type { Register } from "./vim-commands";

interface VimState {
  mode: VimMode;
  /** The first half of `gg`, `dd`, `yy`. */
  pending: string;
  /** Where visual mode started. Meaningless outside it. */
  anchor: number;
  /** The visual cursor: one end of the selection, which itself covers the character under it. */
  head: number;
}

const vimKey = new PluginKey<VimState>("vim");

const INITIAL: VimState = { mode: "insert", pending: "", anchor: 0, head: 0 };

/** The uiEvent metas ProseMirror puts on a change that came from outside the keyboard. */
const FOREIGN_EVENTS = new Set(["paste", "drop", "cut"]);

function vimState(state: EditorState): VimState {
  return vimKey.getState(state) ?? INITIAL;
}

const isVisual = (mode: VimMode): boolean => mode === "visual" || mode === "visual-line";

/**
 * The next Vim state after a transaction. Vim's own carry it. Any other one that moves the
 * selection or the text in visual mode (an arrow, ⌘Z let through) ends visual: the range it
 * remembered no longer says what is selected. One appended after Vim's own only shifts it.
 */
function nextVimState(tr: Transaction, value: VimState): VimState {
  const own = tr.getMeta(vimKey) as VimState | undefined;
  if (own) {
    return own;
  }
  if (!isVisual(value.mode) || (!tr.docChanged && !tr.selectionSet)) {
    return value;
  }
  if (tr.getMeta("appendedTransaction")) {
    return { ...value, anchor: tr.mapping.map(value.anchor), head: tr.mapping.map(value.head) };
  }
  return { ...value, mode: "normal", pending: "" };
}

/** The system clipboard is a courtesy for pasting elsewhere. A refusal is not Vim's concern. */
async function copyOut(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    // No permission, or the window is not focused: the register still holds it
  }
}

/** Cancels a DOM event that would change the text, unless the editor is in insert. */
function refuseOutsideInsert(view: EditorView, event: Event): boolean {
  if (vimState(view.state).mode === "insert") {
    return false;
  }
  event.preventDefault();
  return true;
}

/**
 * Where the Vim commands start from. A block selected whole (a clicked rule) has its head
 * after the block; the commands want its start.
 */
function cursorOf(selection: Selection): number {
  return selection instanceof NodeSelection ? selection.from : selection.head;
}

/** The block cursor: the character under the caret, or a cell standing in on an empty line. */
function cursorDecorations(state: EditorState): DecorationSet {
  const { head, $head } = state.selection;
  if (vimState(state).mode !== "normal" || !$head.parent.inlineContent) {
    return DecorationSet.empty;
  }
  const line = lineAt(state.doc, head);
  const cursor =
    head < line.to
      ? Decoration.inline(head, charAfter(state.doc, head), { class: "vim-cursor" })
      : Decoration.widget(
          head,
          () => {
            const cell = document.createElement("span");
            cell.className = "vim-cursor vim-cursor--empty";
            return cell;
          },
          { side: 1, key: "vim-cursor" },
        );
  return DecorationSet.create(state.doc, [cursor]);
}

/**
 * The Vim layer of the editor. Off unless the setting is on (`vim-setting.ts`), and always
 * starting in insert: the editor must take text the moment a note opens.
 *
 * Two plugins, because Esc has two owners. Normal and visual keys are taken from the DOM
 * keydown, ahead of every keymap, so no list or tab binding sees a key meant for Vim. The
 * insert-mode Esc goes in `late`, a keymap placed after the others, so the link completion
 * can close itself on Esc before Vim turns it into "leave insert".
 *
 * AIDEV-NOTE: guarding with filterTransaction on every doc change was rejected. The table
 * menu and the touch toolbar change the doc from outside the keyboard and must keep working
 * in normal mode. The guard is on the ways typing reaches the doc: keydown, beforeinput,
 * text input, paste, drop and IME composition.
 */
export function createVimPlugins(onMode?: (mode: VimMode) => void): {
  early: ReturnType<typeof $prose>;
  late: ReturnType<typeof $prose>;
} {
  let register: Register | null = null;

  /** Every transaction Vim makes goes out marked, carrying the state Vim moves to. */
  const send = (view: EditorView, tr: Transaction, next: Partial<VimState>): void => {
    view.dispatch(tr.setMeta(vimKey, { ...vimState(view.state), pending: "", ...next }));
  };

  const keep = (next: Register): void => {
    register = next;
    void copyOut(next.text);
  };

  const toNormal = (view: EditorView, head: number): void => {
    const { doc } = view.state;
    send(view, view.state.tr.setSelection(caretAt(doc, clampToLine(doc, head))), {
      mode: "normal",
    });
  };

  const toInsert = (view: EditorView, tr: Transaction): void => {
    send(view, tr, { mode: "insert" });
  };

  const showVisual = (view: EditorView, mode: VimMode, anchor: number, head: number): void => {
    const selection = visualSelection(view.state.doc, anchor, head, mode === "visual-line");
    send(view, view.state.tr.setSelection(selection), { mode, anchor, head });
  };

  // One branch per action, the way the action list reads
  // oxlint-disable-next-line complexity
  const run = (view: EditorView, vim: VimState, action: VimAction): void => {
    const { state } = view;
    const visual = isVisual(vim.mode);
    const head = visual ? vim.head : cursorOf(state.selection);
    const linewise = vim.mode === "visual-line";
    switch (action.type) {
      case "pass":
      case "swallow": {
        return;
      }
      case "normal": {
        toNormal(view, head);
        return;
      }
      case "insert": {
        if (action.at === "open-below" || action.at === "open-above") {
          send(view, state.tr, { mode: "insert" });
          openLine(view, head, action.at === "open-below", (tr) => view.dispatch(tr));
          return;
        }
        toInsert(
          view,
          state.tr.setSelection(caretAt(state.doc, insertPosition(state, head, action.at))),
        );
        return;
      }
      case "visual": {
        const mode = action.linewise ? "visual-line" : "visual";
        showVisual(view, mode, visual ? vim.anchor : head, head);
        return;
      }
      case "move": {
        const target = motionTarget(view, head, action.motion);
        if (visual) {
          showVisual(view, vim.mode, vim.anchor, target);
        } else {
          toNormal(view, target);
        }
        return;
      }
      case "delete-char": {
        const tr = deleteChar(state, head);
        if (tr) {
          keep(charRegister(state, head));
          send(view, tr, { mode: "normal" });
        }
        return;
      }
      case "delete-line": {
        keep(yankLine(state, head));
        send(view, deleteLine(state, head), { mode: "normal" });
        toNormal(view, view.state.selection.head);
        return;
      }
      case "yank-line": {
        keep(yankLine(state, head));
        return;
      }
      case "put": {
        if (register) {
          send(view, put(state, head, register, action.before), { mode: "normal" });
          toNormal(view, view.state.selection.head);
        }
        return;
      }
      case "undo":
      case "redo": {
        (action.type === "undo" ? undo : redo)(state, (tr) => send(view, tr, { mode: "normal" }));
        toNormal(view, view.state.selection.head);
        return;
      }
      case "operate": {
        keep(visualRegister(state, vim.anchor, head, linewise));
        if (action.op === "yank") {
          const [first] = vim.anchor <= head ? [vim.anchor] : [head];
          toNormal(view, first);
          return;
        }
        const tr = deleteVisual(state, vim.anchor, head, linewise, action.op);
        if (action.op === "change") {
          toInsert(view, tr);
        } else {
          send(view, tr, { mode: "normal" });
          toNormal(view, view.state.selection.head);
        }
      }
    }
  };

  const early = $prose(
    () =>
      new Plugin<VimState>({
        key: vimKey,
        state: {
          init: () => INITIAL,
          apply: nextVimState,
        },
        filterTransaction: (tr, state) =>
          vimState(state).mode === "insert" ||
          !tr.docChanged ||
          (tr.getMeta("composition") === undefined &&
            !FOREIGN_EVENTS.has(tr.getMeta("uiEvent") as string)),
        view: () => {
          let last: VimMode = "insert";
          return {
            update: (view) => {
              const { mode } = vimState(view.state);
              if (mode === last) {
                return;
              }
              // The browser drops the focus when the element stops being editable, and
              // the keys would go to the page. Take it back on every change of mode: into
              // insert through ProseMirror, so the caret is drawn where the selection is
              if ((mode === "insert") !== (last === "insert")) {
                if (mode === "insert") {
                  view.focus();
                } else {
                  view.dom.focus({ preventScroll: true });
                }
              }
              last = mode;
              onMode?.(mode);
            },
          };
        },
        props: {
          decorations: cursorDecorations,
          // Outside insert the body is not an editing host. With a Japanese IME on, WebKit
          // starts a composition before the keydown reaches anyone, a composition the editor
          // refuses never ends, and ProseMirror then ignores every key as the IME's (Enter,
          // Esc, ⌘Z included). A non-editable element gives the IME nothing to compose into.
          // tabindex keeps the focus, so the keys still arrive here
          editable: (state) => vimState(state).mode === "insert",
          attributes: (state): Record<string, string> =>
            vimState(state).mode === "insert" ? {} : { class: "vim-normal", tabindex: "0" },
          handleDOMEvents: {
            keydown: (view, event) => {
              const vim = vimState(view.state);
              if (vim.mode === "insert") {
                return false;
              }
              const { action, pending } = interpretKey(vim.mode, vim.pending, keyOf(event));
              if (action.type === "pass") {
                if (vim.pending) {
                  send(view, view.state.tr, { pending: "" });
                }
                return false;
              }
              event.preventDefault();
              if (pending || vim.pending) {
                // Settled before the action: a yank or a dropped key sends nothing of its own
                send(view, view.state.tr, { pending });
              }
              if (!pending) {
                run(view, vimState(view.state), action);
              }
              return true;
            },
            // Whatever the browser would still type or delete on its own (an emacs-style
            // Ctrl-K on a Mac, a dictation) stays out of the text in normal mode. Paste and
            // drop are stopped here rather than in handlePaste / handleDrop: the clipboard
            // plugin sits before this one and would paste first
            beforeinput: refuseOutsideInsert,
            paste: refuseOutsideInsert,
            drop: refuseOutsideInsert,
            // A click in visual mode puts the caret down, as in Vim
            mousedown: (view) => {
              if (isVisual(vimState(view.state).mode)) {
                send(view, view.state.tr, { mode: "normal" });
              }
              return false;
            },
          },
          handleTextInput: (view) => vimState(view.state).mode !== "insert",
        },
      }),
  );

  const late = $prose(
    () =>
      new Plugin({
        props: {
          handleKeyDown: (view, event) => {
            if (vimState(view.state).mode !== "insert" || isImeComposing(event)) {
              return false;
            }
            const { action } = interpretKey("insert", "", keyOf(event));
            if (action.type !== "normal") {
              return false;
            }
            // Leaving insert steps back onto the character just typed, as Vim does
            const { head } = view.state.selection;
            toNormal(
              view,
              head > lineAt(view.state.doc, head).from ? charBefore(view.state.doc, head) : head,
            );
            return true;
          },
        },
      }),
  );

  return { early, late };
}
