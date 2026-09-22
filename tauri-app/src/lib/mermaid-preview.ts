/**
 * Whether the fence language is mermaid. The info string is typed by hand, so
 * differences in case and surrounding whitespace count as the same language.
 */
export function isMermaidLanguage(language: string): boolean {
  return language.trim().toLowerCase() === "mermaid";
}

interface RequestOptions {
  /** Source that is already complete, as at note open, is drawn at once without waiting */
  immediate?: boolean;
}

export interface DebouncedDiagramRenderer {
  request: (source: string, options?: RequestOptions) => void;
  /** Drops the scheduled and in-flight render. Used when the preview itself is folded */
  cancel: () => void;
  dispose: () => void;
}

/**
 * Coalesces mermaid rendering into "once after the hand stops". Rendering is async,
 * so an old render can overtake a new one and arrive later; a version number drops
 * everything but the latest. The render function is injected so this control can be
 * tested without the heavy mermaid itself.
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
      // Advance the version so the in-flight result is invalidated too
      version += 1;
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
