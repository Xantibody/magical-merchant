/**
 * 描画済みの図(mermaid の SVG)をファイルにできる形に整える。保存そのものは
 * `save_export` コマンド(ネイティブの保存ダイアログ)に渡すので、ここから
 * 出るのはコマンドに渡す base64 まで。
 */

export interface Size {
  width: number;
  height: number;
}

export type ExportFormat = "svg" | "png";

/** PNG の解像度。原寸のままだと Retina で文字がにじむ */
const PNG_SCALE = 2;

/**
 * mermaid の出力は HTML としてシリアライズされているので、XML として読むと
 * `&nbsp;` などで壊れることがある。HTML として読み、書き出すときに XML に
 * 直す — XMLSerializer が名前空間を補うので、単体の .svg として開ける
 */
function parseSvg(svg: string): SVGSVGElement | undefined {
  const doc = new DOMParser().parseFromString(svg, "text/html");
  return doc.querySelector("svg") ?? undefined;
}

/** 原寸。mermaid は viewBox にも style の max-width にも同じ値を書く */
export function naturalSize(svg: string): Size | undefined {
  const box = parseSvg(svg)?.viewBox.baseVal;
  if (!box || box.width <= 0 || box.height <= 0) {
    return undefined;
  }
  return { width: box.width, height: box.height };
}

/**
 * 単体のファイルとして開いたときに原寸で出るよう、viewBox の実寸を
 * width / height に入れ、mermaid が本文用に付けた `max-width` を外す。
 * 外さないとビューアによっては幅 100% で開いて縦横比が崩れる
 */
export function sizedSvg(svg: string): string {
  const element = parseSvg(svg);
  if (!element) {
    throw new Error("not an svg");
  }
  const size = naturalSize(svg);
  if (size) {
    element.setAttribute("width", String(Math.round(size.width)));
    element.setAttribute("height", String(Math.round(size.height)));
  }
  element.style.maxWidth = "";
  if (element.getAttribute("style") === "") {
    element.removeAttribute("style");
  }
  return new XMLSerializer().serializeToString(element);
}

/**
 * 文字列を UTF-8 のバイト列として base64 に。`btoa` は Latin-1 しか受けないので
 * 一度バイトにする。spread で一気に渡さないのは、大きな図で引数の数が
 * 呼び出しの上限を超えるため
 */
export function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
}

/**
 * canvas に置ける画素数の上限。WebKit がいちばん厳しく 16M px で、それを超えた
 * canvas は確保に失敗したまま黙って空を返す。長い sequence 図は縦にいくらでも
 * 伸びるので、原寸の 2 倍で描くとこの上限に届く
 */
export const MAX_PNG_PIXELS = 16_777_216;

/** `toDataURL("image/png")` が成功したときに必ず付く頭 */
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

/**
 * 図の原寸から、実際に用意する canvas の大きさ(px)。上限に収まらない図は
 * 解像度を諦めて縮める — 書き出せないより、粗くても絵が出るほうがいい。
 * 端数を切り上げないのは、丸めで上限をまたがないため
 */
export function pngCanvasSize(size: Size): Size {
  const scale = Math.min(PNG_SCALE, Math.sqrt(MAX_PNG_PIXELS / (size.width * size.height)));
  return {
    width: Math.max(1, Math.floor(size.width * scale)),
    height: Math.max(1, Math.floor(size.height * scale)),
  };
}

/**
 * `toDataURL` の返り値から base64 の中身だけを取り出す。canvas が PNG を
 * 作れなかったときは例外ではなく `data:,` が返るので、カンマ以降をそのまま
 * 切ると空の base64 が保存まで届き、0 バイトの PNG が「保存しました」になる
 */
export function pngBase64(dataUrl: string): string {
  const base64 = dataUrl.startsWith(PNG_DATA_URL_PREFIX)
    ? dataUrl.slice(PNG_DATA_URL_PREFIX.length)
    : "";
  if (!base64) {
    throw new Error("canvas produced no png");
  }
  return base64;
}

/**
 * SVG を PNG に描き、base64 で返す。`background` で塗るのは、透明のままだと
 * 暗い背景のビューアで線が消えるため。画像は data URL で読む — Blob URL でも
 * 描けるが、同一生成元の扱いが環境で揺れ、canvas が汚染されると書き出せない
 */
export async function rasterize(svg: string, background: string): Promise<string> {
  const sized = sizedSvg(svg);
  const size = naturalSize(sized);
  if (!size) {
    throw new Error("svg has no size");
  }
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
  await image.decode();

  const canvas = document.createElement("canvas");
  const { width, height } = pngCanvasSize(size);
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("canvas is unavailable");
  }
  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  // toBlob と違って同期で、結果はそのまま base64。汚染されていれば例外
  return pngBase64(canvas.toDataURL("image/png"));
}

/**
 * 保存ダイアログに出す名前。ノートの stem と何番目の図かで決める —
 * 固定名だと 1 つのノートの 2 枚目で上書きを聞かれる
 */
export function exportName(stem: string | undefined, index: number, format: ExportFormat): string {
  return `${stem ?? "diagram"}-${index}.${format}`;
}
