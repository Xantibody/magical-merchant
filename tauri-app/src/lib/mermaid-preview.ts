/**
 * フェンスの言語が mermaid かどうか。info 文字列は手打ちなので、
 * 大文字小文字や前後の空白の揺れは同じ言語として扱う。
 */
export function isMermaidLanguage(language: string): boolean {
  return language.trim().toLowerCase() === "mermaid";
}

interface RequestOptions {
  /** ノート起動時など、既に完成しているソースは待たせず即描く */
  immediate?: boolean;
}

export interface DebouncedDiagramRenderer {
  request: (source: string, options?: RequestOptions) => void;
  /** 予約済み・進行中の描画を捨てる。プレビュー自体を畳むときに使う */
  cancel: () => void;
  dispose: () => void;
}

/**
 * mermaid の描画を「手が止まってから 1 回」にまとめる。描画は非同期なので、
 * 古い描画が新しい描画を追い越して届くことがあり、版数で最新以外を捨てる。
 * render 関数を注入させるのは、重い mermaid 本体なしでこの制御をテストするため。
 */
export function createDebouncedDiagramRenderer(
  render: (source: string) => Promise<string | null>,
  onResult: (svg: string | null) => void,
  delayMs: number,
): DebouncedDiagramRenderer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let version = 0;
  let disposed = false;

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const run = async (source: string): Promise<void> => {
    const current = ++version;
    const svg = await render(source);
    if (!disposed && current === version) {
      onResult(svg);
    }
  };

  return {
    request(source, options) {
      if (disposed) {
        return;
      }
      clearTimer();
      if (options?.immediate) {
        void run(source);
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        void run(source);
      }, delayMs);
    },
    cancel() {
      clearTimer();
      // 進行中の結果も版数を進めて無効化する
      version += 1;
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
