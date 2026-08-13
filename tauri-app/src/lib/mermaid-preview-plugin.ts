import { $view } from "@milkdown/kit/utils";
import { codeBlockSchema } from "@milkdown/kit/preset/commonmark";
import { renderDiagrams } from "./mermaid";
import { isMermaidLanguage, createDebouncedDiagramRenderer } from "./mermaid-preview";
import type { Node } from "@milkdown/kit/prose/model";
import type { NodeView, ViewMutationRecord } from "@milkdown/kit/prose/view";

/** 打鍵が止まったと見なすまでの時間。短いと打鍵中の構文エラー描画が増えるだけ */
const RENDER_DELAY_MS = 400;

/**
 * code_block の node view。pre>code の既定構造は保ちつつ、mermaid のときだけ
 * 直下にレンダリング済みの図をぶら下げる。
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

  private readonly pre: HTMLElement;
  private preview: HTMLElement | undefined;
  private lastSource: string | undefined;
  private lastSvg: string | undefined;

  private readonly renderer = createDebouncedDiagramRenderer(
    async (source) => {
      const [svg] = await renderDiagrams([source]);
      return svg ?? null;
    },
    (svg) => this.applyResult(svg),
    RENDER_DELAY_MS,
  );

  constructor(node: Node) {
    this.dom = document.createElement("div");
    this.dom.className = "code-block-view";
    this.pre = document.createElement("pre");
    this.contentDOM = document.createElement("code");
    this.pre.append(this.contentDOM);
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
  }

  private sync(node: Node, { initial }: { initial: boolean }): void {
    const language = node.attrs.language as string;

    // node view が立つと schema の toDOM は使われない。言語ラベルの CSS が
    // 読む data-language はここで出し直す
    if (language) {
      this.pre.dataset.language = language;
    } else {
      delete this.pre.dataset.language;
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
      // 落ち着きを保ち、まだ一度も描けていないときだけ控えめに伝える
      if (!this.lastSvg) {
        this.showNotice("図を描画できません");
      }
      return;
    }
    this.lastSvg = svg;
    const preview = this.ensurePreview();
    preview.classList.remove("is-error");
    preview.innerHTML = svg;
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
      this.dom.append(this.preview);
    }
    return this.preview;
  }

  private resetPreview(): void {
    // 予約済みの描画を残すと、畳んだ後から図が生えてくる
    this.renderer.cancel();
    this.lastSource = undefined;
    this.lastSvg = undefined;
    this.preview?.remove();
    this.preview = undefined;
  }
}

export const mermaidPreviewPlugin = $view(
  codeBlockSchema.node,
  () =>
    (node): NodeView =>
      new CodeBlockPreviewView(node),
);
