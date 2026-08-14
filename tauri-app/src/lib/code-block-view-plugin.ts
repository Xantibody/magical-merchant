import { $view } from "@milkdown/kit/utils";
import { codeBlockSchema } from "@milkdown/kit/preset/commonmark";
import { TextSelection } from "@milkdown/kit/prose/state";
import copyIcon from "@phosphor-icons/core/assets/regular/copy.svg?raw";
import checkIcon from "@phosphor-icons/core/assets/regular/check.svg?raw";
import { renderDiagrams } from "./mermaid";
import { isMermaidLanguage, createDebouncedDiagramRenderer } from "./mermaid-preview";
import { createCopyFeedback } from "./copy-feedback";
import { LANGUAGE_DATALIST_ID } from "./language-suggestions";
import type { Node } from "@milkdown/kit/prose/model";
import type { EditorView, NodeView, ViewMutationRecord } from "@milkdown/kit/prose/view";

/** 打鍵が止まったと見なすまでの時間。短いと打鍵中の構文エラー描画が増えるだけ */
const RENDER_DELAY_MS = 400;

/** コピー後にチェック表示を戻すまでの時間。押した実感が持てる最短くらい */
const COPY_RESET_MS = 1500;

/**
 * code_block の node view。pre>code の既定構造は保ちつつ、ホバーで現れる
 * コピー ボタンを角に置き、mermaid のときだけ直下にレンダリング済みの図を
 * ぶら下げる。図が最新ソースを描けている間は has-diagram クラスが立ち、
 * カーソルがブロック外にあるとき CSS がソースを隠して図だけを見せる
 * (Slite/Typora 流)。描画に失敗している間はクラスを下ろし、ソースを
 * 隠さない — 隠すと壊れた図を直せなくなる。
 *
 * widget decoration ではなく node view にしたのは、図の寿命がブロックの寿命と
 * 一致するから。decoration set はトランザクションごとに再計算・再マッピングが
 * 要るが、node view ならインスタンスがブロックごとに立ち、debounce タイマーや
 * 直前の SVG をローカルに持てる。Shiki(@milkdown/plugin-highlight)は inline
 * decoration しか使わないので、contentDOM を公開していれば干渉しない。
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
  private node: Node;
  private lastSource: string | undefined;
  private lastSvg: string | undefined;

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
   * 編集ノードの外の部品(図・コピー ボタン・言語入力)への操作は
   * ProseMirror に渡さない。渡すと言語入力の打鍵をエディタの keymap が
   * 拾ったり、図のクリックが node selection になったりする。
   * pre の余白クリック(カーソル配置)は通すため、部品だけに絞る
   */
  stopEvent(event: Event): boolean {
    const { target } = event;
    if (!(target instanceof globalThis.Node)) {
      return false;
    }
    return (
      this.copyButton.contains(target) ||
      this.languageInput.contains(target) ||
      (this.preview?.contains(target) ?? false)
    );
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    if (mutation.type === "selection") {
      return false;
    }
    // 図の差し込みや data-language の付け替えを ProseMirror が「外部からの
    // 編集」と誤認して re-parse すると、カーソルとスクロールが飛ぶ
    return !this.contentDOM.contains(mutation.target);
  }

  destroy(): void {
    this.renderer.dispose();
    this.copyFeedback.dispose();
  }

  /**
   * ホバーで現れるコピー ボタン(表示制御は CSS)。編集ノードの外なので
   * contentEditable を切り、mousedown を止めてカーソルと選択を守る
   */
  private createCopyButton(): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy-button";
    button.contentEditable = "false";
    button.tabIndex = -1;
    button.setAttribute("aria-label", "コードをコピー");
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
   * 言語ラベルを兼ねる小さな入力。datalist(highlighter の読込済み言語+
   * mermaid)から補完が出る。未知言語のハイライトを黙ってスキップする分
   * (#101)、綴り違いに気づく場所はここになる
   */
  private createLanguageInput(): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "code-language-input";
    input.setAttribute("list", LANGUAGE_DATALIST_ID);
    input.setAttribute("aria-label", "言語");
    input.placeholder = "言語";
    input.spellcheck = false;
    input.autocapitalize = "off";
    input.tabIndex = -1;
    input.addEventListener("change", () => {
      this.commitLanguage(input.value);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        // change(コミット)を発火させてから、続けて書けるよう本文へ戻す
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

    // node view が立つと schema の toDOM は使われない。data-language は
    // ここで出し直す(スタイルのフックとして残す)
    if (language) {
      this.pre.dataset.language = language;
    } else {
      delete this.pre.dataset.language;
    }

    // 編集中の値をエディタ側の更新で潰さない
    if (document.activeElement !== this.languageInput) {
      this.languageInput.value = language;
    }

    if (!isMermaidLanguage(language)) {
      this.resetPreview();
      return;
    }

    const source = node.textContent;
    // update は選択移動やハイライト装飾の更新でも呼ばれる。ソースが同じなら
    // 描画し直さない(変換の局所化)
    if (source === this.lastSource) {
      return;
    }
    this.lastSource = source;

    if (source.trim() === "") {
      this.resetPreview();
      return;
    }
    this.renderer.request(source, { immediate: initial });
  }

  private applyResult(svg: string | null): void {
    if (svg === null) {
      // 打鍵の途中は書きかけの構文になるのが普通。最後に描けた図を残して
      // 落ち着きを保ち、まだ一度も描けていないときだけ控えめに伝える。
      // 描けていない間はソースを隠さない(隠すと直せない)
      this.dom.classList.remove("has-diagram");
      if (!this.lastSvg) {
        this.showNotice("図を描画できません");
      }
      return;
    }
    this.lastSvg = svg;
    const preview = this.ensurePreview();
    preview.classList.remove("is-error");
    preview.innerHTML = svg;
    this.dom.classList.add("has-diagram");
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
      // 図は読み取り専用。編集対象はあくまで上のコードブロック
      this.preview.contentEditable = "false";
      // 図だけの表示のとき、図をクリックしたらソースを開いて編集に入る
      this.preview.addEventListener("click", () => {
        this.focusSource();
      });
      this.dom.append(this.preview);
    }
    return this.preview;
  }

  /** カーソルをブロック末尾に置いて is-active(ソース表示)に入る */
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
    // 予約済みの描画を残すと、畳んだ後から図が生えてくる
    this.renderer.cancel();
    this.lastSource = undefined;
    this.lastSvg = undefined;
    this.preview?.remove();
    this.preview = undefined;
    this.dom.classList.remove("has-diagram");
  }
}

export const codeBlockViewPlugin = $view(
  codeBlockSchema.node,
  () =>
    (node, view, getPos): NodeView =>
      new CodeBlockPreviewView(node, view, getPos),
);
