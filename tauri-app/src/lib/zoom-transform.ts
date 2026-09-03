/**
 * 図のズーム画面の座標計算。DOM を触らない純関数なので、ホイール・ピンチ・
 * ボタンのどれから来ても同じ式で動き、テストは数値だけで書ける。
 *
 * 変換は `translate(tx, ty) scale(s)`。tx/ty は画面のピクセル、図の左上が
 * どこに来るか。倍率を変えるときは「カーソルの下の点が動かない」ように
 * 平行移動を合わせて直す — そうしないと拡大のたびに図が逃げていく。
 */

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Transform {
  scale: number;
  tx: number;
  ty: number;
}

export const MIN_SCALE = 0.15;
export const MAX_SCALE = 8;

/** 開いたときに原寸の何倍まで広げるか。小さい図を画面いっぱいにするとぼやけるだけ */
const FIT_MAX_SCALE = 2;

/** 開いたときに図の周りに残す余白(px)。閉じるボタンやコントロールが図に被らない */
const FIT_PADDING = 96;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** 画面の真ん中に、余白を残して収まる大きさで置く */
export function fitToViewport(viewport: Size, diagram: Size): Transform {
  const scale = clamp(
    Math.min(
      (viewport.width - FIT_PADDING) / diagram.width,
      (viewport.height - FIT_PADDING) / diagram.height,
      FIT_MAX_SCALE,
    ),
    MIN_SCALE,
    MAX_SCALE,
  );
  return {
    scale,
    tx: (viewport.width - diagram.width * scale) / 2,
    ty: (viewport.height - diagram.height * scale) / 2,
  };
}

/** `point`(画面座標)の下にある図の点を動かさずに倍率を `factor` 倍する */
export function zoomAtPoint(current: Transform, point: Point, factor: number): Transform {
  const scale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE);
  if (scale === current.scale) {
    return current;
  }
  const k = scale / current.scale;
  return {
    scale,
    tx: point.x - (point.x - current.tx) * k,
    ty: point.y - (point.y - current.ty) * k,
  };
}

/**
 * ホイール 1 回ぶんの倍率。指数にするのは、上に 100 回して下に 100 戻せば
 * ちょうど元に戻るため。トラックパッドのピンチはブラウザが ctrl+wheel で
 * 届けてくる。1 回の delta が小さいので、係数を上げて指の動きに追いつかせる
 */
export function wheelFactor(deltaY: number, pinch: boolean): number {
  return Math.exp(-deltaY * (pinch ? 0.01 : 0.0022));
}

export function toCss(transform: Transform): string {
  return `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.scale})`;
}
