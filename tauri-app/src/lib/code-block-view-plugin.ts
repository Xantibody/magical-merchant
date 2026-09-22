import { $view } from "@milkdown/kit/utils";
import { codeBlockSchema } from "@milkdown/kit/preset/commonmark";
import { TextSelection } from "@milkdown/kit/prose/state";
import copyIcon from "@phosphor-icons/core/assets/regular/copy.svg?raw";
import checkIcon from "@phosphor-icons/core/assets/regular/check.svg?raw";
import { t } from "./i18n";
import { extractCaption } from "./diagram-caption";
import { setDiagramPending } from "./diagram-pending";
import { renderDiagrams } from "./mermaid";
import { isMermaidLanguage, createDebouncedDiagramRenderer } from "./mermaid-preview";
import { createCopyFeedback } from "./copy-feedback";
import { LANGUAGE_DATALIST_ID } from "./language-suggestions";
import type { Node } from "@milkdown/kit/prose/model";
import type { EditorView, NodeView, ViewMutationRecord } from "@milkdown/kit/prose/view";

/** How long typing must pause before it counts as stopped. Shorter only draws more syntax errors mid-typing */
const RENDER_DELAY_MS = 400;

/** How long the check mark stays after a copy. About the shortest that still feels like a press */
const COPY_RESET_MS = 1500;

/**
 * Node view for code_block. It keeps the default pre>code structure, puts a
 * copy button that appears on hover in the corner, and only for mermaid hangs
 * the rendered diagram right below. While the diagram reflects the latest
 * source the has-diagram class is set, and CSS hides the source and shows only
 * the diagram when the cursor is outside the block (the Slite/Typora way).
 * While rendering fails the class is dropped and the source stays visible:
 * hiding it would make a broken diagram impossible to fix.
 *
 * A node view rather than a widget decoration, because the diagram's lifetime
 * matches the block's. A decoration set must be recomputed and remapped on
 * every transaction; a node view gets one instance per block and can hold the
 * debounce timer and the previous SVG locally. Shiki (@milkdown/plugin-highlight)
 * uses only inline decorations, so it does not interfere as long as contentDOM
 * is exposed.
 */
class CodeBlockPreviewView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;

  private readonly view: EditorView;
  private readonly getPos: () => number | undefined;
  private readonly pre: HTMLElement;
  private readonly copyButton: HTMLButtonElement;
  private readonly languageInput: HTMLInputElement;
  private preview: HTMLElement | undefined;
  private caption: HTMLElement | undefined;
  private node: Node;
  private lastSource: string | undefined;
  private lastSvg: string | undefined;
  /** Caption of the source sent for rendering. Carried until the result so it appears with the diagram */
  private pendingCaption: string | undefined;

  private readonly copyFeedback = createCopyFeedback(
    (text) => navigator.clipboard.writeText(text),
    (copied) => this.applyCopyState(copied),
    COPY_RESET_MS,
  );

  private readonly renderer = createDebouncedDiagramRenderer(
    async (source) => {
      const [svg] = await renderDiagrams([source]);
      return svg ?? null;
    },
    (svg) => this.applyResult(svg),
    RENDER_DELAY_MS,
  );

  constructor(node: Node, view: EditorView, getPos: () => number | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.dom = document.createElement("div");
    this.dom.className = "code-block-view";
    this.pre = document.createElement("pre");
    this.contentDOM = document.createElement("code");
    this.copyButton = this.createCopyButton();
    this.languageInput = this.createLanguageInput();
    this.pre.append(this.contentDOM, this.languageInput, this.copyButton);
    this.dom.append(this.pre);
    this.sync(node, { initial: true });
  }

  update(node: Node): boolean {
    if (node.type.name !== "code_block") {
      return false;
    }
    this.sync(node, { initial: false });
    return true;
  }

  /**
   * Events on the parts outside the editable node (diagram, caption, copy
   * button, language input) are not passed to ProseMirror. If they were, the
   * editor keymap would pick up keystrokes in the language input, and a click
   * on the diagram would become a node selection. A click in the pre's margin
   * (placing the cursor) must still go through, so only those parts are stopped
   */
  stopEvent(event: Event): boolean {
    const { target } = event;
    if (!(target instanceof globalThis.Node)) {
      return false;
    }
    return (
      this.copyButton.contains(target) ||
      this.languageInput.contains(target) ||
      (this.preview?.contains(target) ?? false) ||
      (this.caption?.contains(target) ?? false)
    );
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    if (mutation.type === "selection") {
      return false;
    }
    // If ProseMirror mistook inserting the diagram or swapping data-language for
    // an "external edit" and re-parsed, the cursor and the scroll would jump
    return !this.contentDOM.contains(mutation.target);
  }

  destroy(): void {
    this.renderer.dispose();
    this.copyFeedback.dispose();
    // The render will never finish now. Do not make the waiting side wait until its deadline
    setDiagramPending(this.dom, false);
  }

  /**
   * Copy button that appears on hover (visibility is controlled by CSS). It is
   * outside the editable node, so contentEditable is off and mousedown is
   * stopped to protect the cursor and the selection
   */
  private createCopyButton(): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy-button";
    button.contentEditable = "false";
    button.tabIndex = -1;
    button.setAttribute("aria-label", t().editor.copyCode);
    button.innerHTML = copyIcon;
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    button.addEventListener("click", () => {
      this.copyFeedback.copy(this.node.textContent);
    });
    return button;
  }

  private applyCopyState(copied: boolean): void {
    this.copyButton.classList.toggle("is-copied", copied);
    this.copyButton.innerHTML = copied ? checkIcon : copyIcon;
  }

  /**
   * Small input that doubles as the language label. Completion comes from the
   * datalist (the highlighter's loaded languages plus mermaid). Since
   * highlighting an unknown language is skipped silently (#101), this is the
   * place where a misspelling gets noticed
   */
  private createLanguageInput(): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "code-language-input";
    input.setAttribute("list", LANGUAGE_DATALIST_ID);
    input.setAttribute("aria-label", t().editor.language);
    input.placeholder = t().editor.language;
    input.spellcheck = false;
    input.autocapitalize = "off";
    input.tabIndex = -1;
    input.addEventListener("change", () => {
      this.commitLanguage(input.value);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        // Fire change (the commit) first, then return to the body so writing can continue
        event.preventDefault();
        input.blur();
        this.focusSource();
      } else if (event.key === "Escape") {
        input.value = this.node.attrs.language as string;
        input.blur();
      }
    });
    return input;
  }

  private commitLanguage(value: string): void {
    const pos = this.getPos();
    if (pos === undefined) {
      return;
    }
    const language = value.trim();
    if (language === (this.node.attrs.language as string)) {
      return;
    }
    const { state } = this.view;
    this.view.dispatch(state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, language }));
  }

  private sync(node: Node, { initial }: { initial: boolean }): void {
    this.node = node;
    const language = node.attrs.language as string;

    // Once a node view exists the schema's toDOM is not used. data-language is
    // re-emitted here (kept as a hook for styles)
    if (language) {
      this.pre.dataset.language = language;
    } else {
      delete this.pre.dataset.language;
    }

    // Do not overwrite a value being edited with an update from the editor side
    if (document.activeElement !== this.languageInput) {
      this.languageInput.value = language;
    }

    if (!isMermaidLanguage(language)) {
      this.resetPreview();
      return;
    }

    const source = node.textContent;
    // update is also called for selection moves and highlight decoration
    // updates. Same source, no re-render (keep the transform local)
    if (source === this.lastSource) {
      return;
    }
    this.lastSource = source;
    this.pendingCaption = extractCaption(source);

    if (source.trim() === "") {
      this.resetPreview();
      return;
    }
    // From here until the diagram lands, the block takes the source's height.
    // Tell the outside that the height is not settled, so the side that maps
    // coordinates to positions can wait (#168)
    setDiagramPending(this.dom, true);
    this.renderer.request(source, { immediate: initial });
  }

  private applyResult(svg: string | null): void {
    this.showResult(svg);
    // Rendered or not, the height is settled at this point
    setDiagramPending(this.dom, false);
  }

  private showResult(svg: string | null): void {
    if (svg === null) {
      // Mid-typing the syntax is usually incomplete. Keep the last diagram that
      // rendered so nothing flickers, and only say so quietly when nothing has
      // rendered yet. While it fails, do not hide the source (hidden, it cannot be fixed)
      this.dom.classList.remove("has-diagram");
      if (!this.lastSvg) {
        this.showNotice(t().editor.diagramFailed);
        this.applyCaption();
      }
      return;
    }
    this.lastSvg = svg;
    const preview = this.ensurePreview();
    preview.classList.remove("is-error");
    preview.innerHTML = svg;
    this.applyCaption(this.pendingCaption);
    this.dom.classList.add("has-diagram");
  }

  /**
   * Show `%% caption:` below the diagram as the same figcaption the preview
   * uses. Showing it only on the reading side makes the diagram's height differ
   * between the two surfaces, breaks the assumption that the cursor lands on the
   * character at the pressed coordinates, and shifts the body below by one
   * block (#168).
   *
   * Only the text is replaced; the element is not rebuilt. Swapping the node
   * makes the cursor jump when the selection sits inside it
   */
  private applyCaption(text?: string): void {
    if (text === undefined) {
      this.caption?.remove();
      this.caption = undefined;
      return;
    }
    if (!this.caption) {
      this.caption = document.createElement("figcaption");
      this.caption.className = "mermaid-caption";
      // Not editable, like the diagram. What gets edited is the source above
      this.caption.contentEditable = "false";
      this.dom.append(this.caption);
    }
    this.caption.textContent = text;
  }

  private showNotice(text: string): void {
    const preview = this.ensurePreview();
    preview.classList.add("is-error");
    preview.textContent = text;
  }

  private ensurePreview(): HTMLElement {
    if (!this.preview) {
      this.preview = document.createElement("div");
      this.preview.className = "mermaid-editor-preview";
      // The diagram is read-only. What gets edited is the code block above
      this.preview.contentEditable = "false";
      // When only the diagram is shown, a click on it opens the source for editing
      this.preview.addEventListener("click", () => {
        this.focusSource();
      });
      this.dom.append(this.preview);
    }
    return this.preview;
  }

  /** Put the cursor at the end of the block and enter is-active (source shown) */
  private focusSource(): void {
    const pos = this.getPos();
    if (pos === undefined) {
      return;
    }
    const { state } = this.view;
    const end = pos + this.node.nodeSize - 1;
    this.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, end)));
    this.view.focus();
  }

  private resetPreview(): void {
    // A render left scheduled would grow a diagram after the block was folded
    this.renderer.cancel();
    this.lastSource = undefined;
    this.lastSvg = undefined;
    this.pendingCaption = undefined;
    this.preview?.remove();
    this.preview = undefined;
    this.applyCaption();
    this.dom.classList.remove("has-diagram");
    // The result of the discarded render never arrives. The folded shape settles the height
    setDiagramPending(this.dom, false);
  }
}

export const codeBlockViewPlugin = $view(
  codeBlockSchema.node,
  () =>
    (node, view, getPos): NodeView =>
      new CodeBlockPreviewView(node, view, getPos),
);
