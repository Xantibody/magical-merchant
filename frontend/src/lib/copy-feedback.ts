export interface CopyFeedback {
  copy: (text: string) => void;
  dispose: () => void;
}

/**
 * Controls the copied indicator of a copy action. It reports copied only when the write
 * succeeded and returns on its own after a fixed time. Repeated presses leave only the last
 * reset pending. writeText is injected so this control can be tested without a real
 * clipboard.
 */
export function createCopyFeedback(
  writeText: (text: string) => Promise<void>,
  onStateChange: (copied: boolean) => void,
  resetMs: number,
): CopyFeedback {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return {
    copy(text) {
      if (disposed) {
        return;
      }
      void (async () => {
        try {
          await writeText(text);
        } catch {
          // Stay silent when the clipboard is unavailable. Better than a false copied state
          return;
        }
        if (disposed) {
          return;
        }
        clearTimer();
        onStateChange(true);
        timer = setTimeout(() => {
          timer = undefined;
          onStateChange(false);
        }, resetMs);
      })();
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
