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

/**
 * 測れた辺かどうか。隠れている面や描き終える前の SVG は 0 を返し、
 * 属性の無い SVGRect は NaN を返す。どちらも割り算に入れてはいけない
 */
function measured(length: number): boolean {
  return Number.isFinite(length) && length > 0;
}

/**
 * 開いたときの原寸。mermaid は viewBox に原寸を書くのでそれを読み、viewBox を
 * 持たない SVG は縮めて描いている今の大きさ(`getBoundingClientRect`)で代用する。
 * どちらも測れなければ答えを返さない — 0×0 で開いても白い画面が出るだけ
 */
export function zoomSize(viewBox: Size, rendered: Size): Size | undefined {
  const width = measured(viewBox.width) ? viewBox.width : rendered.width;
  const height = measured(viewBox.height) ? viewBox.height : rendered.height;
  return measured(width) && measured(height) ? { width, height } : undefined;
}

/** 倍率を測れないときに置く場所。原寸のまま左上に */
const NATURAL: Transform = { scale: 1, tx: 0, ty: 0 };

/**
 * 画面の真ん中に、余白を残して収まる大きさで置く。どちらかが測れていなければ
 * 原寸のまま置く — 0 で割った倍率は NaN や Infinity になり、transform ごと
 * 無視されて図が消え、倍率の表示が「NaN%」になる
 */
export function fitToViewport(viewport: Size, diagram: Size): Transform {
  if (
    !measured(viewport.width) ||
    !measured(viewport.height) ||
    !measured(diagram.width) ||
    !measured(diagram.height)
  ) {
    return NATURAL;
  }
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
