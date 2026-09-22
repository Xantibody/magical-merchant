/**
 * Shapes a rendered diagram (mermaid's SVG) into something that can become a file.
 * The saving itself goes to the `save_export` command (the native save dialog), so
 * what leaves here is only the base64 handed to that command.
 */

export interface Size {
  width: number;
  height: number;
}

export type ExportFormat = "svg" | "png";

/** PNG resolution. At natural size the text blurs on Retina */
const PNG_SCALE = 2;

/**
 * mermaid's output is serialised as HTML, so reading it as XML can break on
 * `&nbsp;` and the like. Read it as HTML and fix it up to XML on the way out:
 * XMLSerializer fills in the namespaces, so the file opens as a standalone .svg
 */
function parseSvg(svg: string): SVGSVGElement | undefined {
  const doc = new DOMParser().parseFromString(svg, "text/html");
  return doc.querySelector("svg") ?? undefined;
}

/** Natural size. mermaid writes the same value into the viewBox and the style's max-width */
export function naturalSize(svg: string): Size | undefined {
  const box = parseSvg(svg)?.viewBox.baseVal;
  if (!box || box.width <= 0 || box.height <= 0) {
    return undefined;
  }
  return { width: box.width, height: box.height };
}

/**
 * Puts the viewBox's real size into width / height so the file opens at natural
 * size on its own, and removes the `max-width` mermaid added for the note body.
 * Left in, some viewers open it at 100% width and the aspect ratio breaks.
 *
 * A diagram whose labels are still foreignObject (HTML) is thrown, not exported.
 * The browser does not draw foreignObject inside an SVG loaded as `<img>`, so the
 * PNG stays a "valid data URL" with only the text missing, and passes silently to the save.
 * AIDEV-NOTE: mermaid's secure htmlLabels is the real fix. This is the last line of defence against diagram types and future loopholes
 */
export function sizedSvg(svg: string): string {
  const element = parseSvg(svg);
  if (!element) {
    throw new Error("not an svg");
  }
  if (element.querySelector("foreignObject")) {
    throw new Error("svg has html labels");
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
 * A string as UTF-8 bytes in base64. `btoa` accepts only Latin-1, so go through
 * bytes first. Not passed in one go with spread because on a large diagram the
 * argument count exceeds the call limit
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
 * Upper bound on the pixels a canvas can hold. WebKit is the strictest at 16M px,
 * and a canvas beyond that fails to allocate and silently returns blank. A long
 * sequence diagram grows downward without limit, so drawing at 2x natural size reaches this bound
 */
export const MAX_PNG_PIXELS = 16_777_216;

/** The prefix always present when `toDataURL("image/png")` succeeds */
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

/**
 * From the diagram's natural size, the size (px) of the canvas actually prepared.
 * A diagram that does not fit the bound gives up resolution and shrinks: a coarse
 * picture beats no export. No rounding up, so that rounding never crosses the bound
 */
export function pngCanvasSize(size: Size): Size {
  const scale = Math.min(PNG_SCALE, Math.sqrt(MAX_PNG_PIXELS / (size.width * size.height)));
  return {
    width: Math.max(1, Math.floor(size.width * scale)),
    height: Math.max(1, Math.floor(size.height * scale)),
  };
}

/**
 * Takes only the base64 payload out of the `toDataURL` result. When the canvas could
 * not make a PNG it returns `data:,` instead of throwing, so cutting after the comma
 * would let an empty base64 reach the save, and a 0-byte PNG would report "saved"
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
 * Draws the SVG as a PNG and returns base64. `background` is painted because left
 * transparent the lines vanish in a viewer with a dark background. The image is read
 * from a data URL: a Blob URL draws too, but same-origin handling varies by
 * environment, and a tainted canvas cannot be exported
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

  // Unlike toBlob this is synchronous, and the result is base64 as is. Throws if tainted
  return pngBase64(canvas.toDataURL("image/png"));
}

/**
 * The name shown in the save dialog. Decided by the note's stem and which diagram
 * it is: a fixed name asks about overwriting on the second diagram of one note
 */
export function exportName(stem: string | undefined, index: number, format: ExportFormat): string {
  return `${stem ?? "diagram"}-${index}.${format}`;
}
