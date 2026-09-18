/**
 * タッチ端末の長押し検出。ポインタイベントのハンドラ束として返し、
 * 要素側にそのまま繋ぐ。
 *
 * マウスは対象にしない — PC にはホバーで出るボタンがあり、マウスの
 * 長押しはドラッグやテキスト選択と衝突するだけで得るものがない。
 */

interface PointerLike {
  pointerType: string;
  clientX: number;
  clientY: number;
}

interface PointLike {
  clientX: number;
  clientY: number;
}

interface Cancelable {
  preventDefault: () => void;
}

/**
 * 指の揺れとして見逃す移動量(px)。これを超えたらスクロールの始まり。
 */
// AIDEV-NOTE: 10px は Chrome のタッチスロップ(8px)より少し広く取った値。0 だと置いた指の jitter で 500ms を完走できない(#253)
const SLIP_PX = 10;

export interface LongPress {
  onPointerDown: (e: PointerLike) => void;
  onPointerUp: () => void;
  onPointerMove: (e: PointLike) => void;
  onPointerCancel: () => void;
  /**
   * 長押しを割り当てた要素の上では OS のメニューを出さない。押しっぱなしは
   * WebView から見るとテキスト選択の始まりで、放っておくと「コピー」の
   * メニューが長押しの手応えに割り込む。選択そのものを止めるのは要素側の
   * `.long-press`(base.css) — こちらは Android の contextmenu を受ける
   */
  onContextMenu: (e: Cancelable) => void;
  /**
   * 直後の click をそのまま処理してよいか。長押しが発火したあとに指を
   * 離すとブラウザは click も飛ばすので、その 1 回だけを飲み込む。
   */
  shouldClick: () => boolean;
}

export function createLongPress(onLongPress: () => void, holdMs = 500): LongPress {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired = false;
  /** 指が降りた場所。ここからの距離だけが「動いた」の判断材料。 */
  let origin: PointLike | undefined;

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
      // 揺れの許容は押すたびに測り直す。少しずつ流れた指でも 2 回目が
      // 始めから許容いっぱいということにはならない
      origin = { clientX: e.clientX, clientY: e.clientY };
      timer = setTimeout(() => {
        timer = undefined;
        fired = true;
        onLongPress();
      }, holdMs);
    },
    onPointerUp: cancel,
    /**
     * 指を置いているだけでも pointermove は絶え間なく来る。1 回で捨てると
     * 長押しは実機で完走しないので、降りた場所から離れたときだけ諦める。
     */
    onPointerMove: (e) => {
      if (!timer || !origin) {
        return;
      }
      const dx = e.clientX - origin.clientX;
      const dy = e.clientY - origin.clientY;
      if (dx * dx + dy * dy > SLIP_PX * SLIP_PX) {
        cancel();
      }
    },
    onPointerCancel: () => {
      cancel();
      // 押している間に OS がジェスチャを横取りした場合。click は来ない
      fired = false;
    },
    onContextMenu: (e) => e.preventDefault(),
    shouldClick: () => {
      if (fired) {
        fired = false;
        return false;
      }
      return true;
    },
  };
}
