import { createSignal, onCleanup, onMount } from "solid-js";
import { t } from "../lib/i18n";
import { fitToViewport, toCss, wheelFactor, zoomAtPoint } from "../lib/zoom-transform";
import Icon from "./Icon";
import type { Point, Transform } from "../lib/zoom-transform";
import type { JSX } from "solid-js";

export interface ZoomedDiagram {
  svg: string;
  /** 図の原寸(px)。viewBox の幅と高さで、mermaid が SVG の max-width に書く値と同じ */
  width: number;
  height: number;
}

/** 右下のボタン 1 回ぶんの倍率。±25% の感覚 */
const STEP = 1.25;

/** ダブルクリック 1 回ぶんの倍率。ボタンより大きく、一度で「そこを読む」大きさに */
const DOUBLE_CLICK = 1.6;

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** ボタンの上ではドラッグもダブルクリック拡大も始めない */
function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button") !== null;
}

/**
 * 図を全画面で読む。ホイール(トラックパッドのピンチは ctrl+wheel)と 2 本指で
 * 倍率、ドラッグで位置。開いたときは画面に収まる大きさで真ん中に置く。
 *
 * 背景を押しても閉じない — ドラッグの始点と区別が付かない。閉じるのは
 * Escape か右上の ✕。
 */
export default function DiagramZoom(props: {
  diagram: ZoomedDiagram;
  onClose: () => void;
}): JSX.Element {
  let root: HTMLDivElement | undefined;
  let canvas: HTMLDivElement | undefined;

  // 倍率と位置は signal にしない。ホイールやドラッグの 1 動作ごとに再描画を
  // 起こさず、DOM の transform を直接書く。画面に出すのは倍率の数字だけ
  let current: Transform = { scale: 1, tx: 0, ty: 0 };
  const [percent, setPercent] = createSignal(100);

  const apply = (next: Transform): void => {
    current = next;
    if (canvas) {
      canvas.style.transform = toCss(next);
    }
    setPercent(Math.round(next.scale * 100));
  };

  const viewport = (): { width: number; height: number } => ({
    width: root?.clientWidth ?? 0,
    height: root?.clientHeight ?? 0,
  });

  const fitToScreen = (): void => {
    apply(fitToViewport(viewport(), props.diagram));
  };

  /** 画面座標 → この画面の左上からの座標 */
  const local = (clientX: number, clientY: number): Point => {
    const rect = root?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  };

  const zoomAt = (point: Point, factor: number): void => {
    apply(zoomAtPoint(current, point, factor));
  };

  const zoomCenter = (factor: number): void => {
    const { width, height } = viewport();
    zoomAt({ x: width / 2, y: height / 2 }, factor);
  };

  // 押されている指(ポインタ)。1 本ならドラッグ、2 本ならピンチ
  const pointers = new Map<number, Point>();

  const onPointerDown = (e: PointerEvent): void => {
    if (isControl(e.target)) {
      return;
    }
    root?.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e.clientX, e.clientY));
    root?.classList.add("is-dragging");
  };

  const onPointerMove = (e: PointerEvent): void => {
    const previous = pointers.get(e.pointerId);
    if (!previous) {
      return;
    }
    const point = local(e.clientX, e.clientY);
    pointers.set(e.pointerId, point);

    if (pointers.size === 1) {
      apply({
        ...current,
        tx: current.tx + point.x - previous.x,
        ty: current.ty + point.y - previous.y,
      });
      return;
    }
    // ピンチ: 2 本の間隔の変化が倍率、中点の移動が平行移動
    const other = [...pointers.entries()].find(([id]) => id !== e.pointerId)?.[1];
    if (!other) {
      return;
    }
    const before = midpoint(previous, other);
    const after = midpoint(point, other);
    const spread = distance(previous, other);
    const factor = spread > 0 ? distance(point, other) / spread : 1;
    const zoomed = zoomAtPoint(current, before, factor);
    apply({ ...zoomed, tx: zoomed.tx + after.x - before.x, ty: zoomed.ty + after.y - before.y });
  };

  const onPointerEnd = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) {
      root?.classList.remove("is-dragging");
    }
  };

  const onDblClick = (e: MouseEvent): void => {
    if (!isControl(e.target)) {
      zoomAt(local(e.clientX, e.clientY), DOUBLE_CLICK);
    }
  };

  onMount(() => {
    fitToScreen();

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        props.onClose();
      }
    };
    globalThis.addEventListener("keydown", onKeyDown);
    onCleanup(() => globalThis.removeEventListener("keydown", onKeyDown));

    // passive にしない。preventDefault できないと、ピンチ(ctrl+wheel)が
    // ページ全体のズームとして OS に取られる
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      zoomAt(local(e.clientX, e.clientY), wheelFactor(e.deltaY, e.ctrlKey));
    };
    root?.addEventListener("wheel", onWheel, { passive: false });
    onCleanup(() => root?.removeEventListener("wheel", onWheel));
  });

  return (
    <div
      ref={root}
      class="mermaid-zoom"
      role="presentation"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onDblClick={onDblClick}
    >
      <div
        ref={canvas}
        class="mermaid-zoom-canvas"
        style={{ width: `${props.diagram.width}px` }}
        innerHTML={props.diagram.svg}
      />
      <button
        type="button"
        class="icon-button mermaid-zoom-close"
        title={t().common.close}
        aria-label={t().common.close}
        onClick={() => props.onClose()}
      >
        <Icon name="x" size={18} />
      </button>
      <div class="mermaid-zoom-controls">
        <button
          type="button"
          class="icon-button"
          title={t().preview.zoomOut}
          aria-label={t().preview.zoomOut}
          onClick={() => zoomCenter(1 / STEP)}
        >
          <Icon name="magnifying-glass-minus" size={16} />
        </button>
        <span class="mermaid-zoom-percent">{percent()}%</span>
        <button
          type="button"
          class="icon-button"
          title={t().preview.zoomIn}
          aria-label={t().preview.zoomIn}
          onClick={() => zoomCenter(STEP)}
        >
          <Icon name="magnifying-glass-plus" size={16} />
        </button>
        <button
          type="button"
          class="icon-button"
          title={t().preview.fit}
          aria-label={t().preview.fit}
          onClick={fitToScreen}
        >
          <Icon name="corners-in" size={16} />
        </button>
      </div>
      <p class="mermaid-zoom-hint">{t().preview.zoomHint}</p>
    </div>
  );
}
