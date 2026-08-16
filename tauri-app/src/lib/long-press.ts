/**
 * タッチ端末の長押し検出。ポインタイベントのハンドラ束として返し、
 * 要素側にそのまま繋ぐ。
 *
 * マウスは対象にしない — PC にはホバーで出るボタンがあり、マウスの
 * 長押しはドラッグやテキスト選択と衝突するだけで得るものがない。
 */

interface PointerLike {
  pointerType: string;
}

export interface LongPress {
  onPointerDown: (e: PointerLike) => void;
  onPointerUp: () => void;
  onPointerMove: () => void;
  onPointerCancel: () => void;
  /**
   * 直後の click をそのまま処理してよいか。長押しが発火したあとに指を
   * 離すとブラウザは click も飛ばすので、その 1 回だけを飲み込む。
   */
  shouldClick: () => boolean;
}

export function createLongPress(onLongPress: () => void, holdMs = 500): LongPress {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired = false;

  const cancel = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return {
    onPointerDown: (e) => {
      if (e.pointerType === "mouse") {
        return;
      }
      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        fired = true;
        onLongPress();
      }, holdMs);
    },
    onPointerUp: cancel,
    onPointerMove: cancel,
    onPointerCancel: () => {
      cancel();
      // 押している間に OS がジェスチャを横取りした場合。click は来ない
      fired = false;
    },
    shouldClick: () => {
      if (fired) {
        fired = false;
        return false;
      }
      return true;
    },
  };
}
