export interface CopyFeedback {
  copy(text: string): void;
  dispose(): void;
}

/**
 * コピー操作の「コピー済み」表示を制御する。書き込みが成功したときだけ
 * copied を報せ、一定時間後に自動で戻す。連打してもリセットは最後の
 * 1 回分だけ。writeText を注入させるのは、実クリップボードなしで
 * この制御をテストするため。
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
          // クリップボードが使えないときは黙る。誤った「コピー済み」を出すよりよい
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
