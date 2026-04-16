import { splitProps, createEffect } from "solid-js";
import type { JSX } from "solid-js";

const ICONS = {
  lightning: () => import("@phosphor-icons/core/assets/regular/lightning.svg?raw"),
  "note-pencil": () => import("@phosphor-icons/core/assets/regular/note-pencil.svg?raw"),
  "check-square": () => import("@phosphor-icons/core/assets/regular/check-square.svg?raw"),
  list: () => import("@phosphor-icons/core/assets/regular/list.svg?raw"),
  "paper-plane-tilt": () => import("@phosphor-icons/core/assets/regular/paper-plane-tilt.svg?raw"),
  sun: () => import("@phosphor-icons/core/assets/regular/sun.svg?raw"),
  moon: () => import("@phosphor-icons/core/assets/regular/moon.svg?raw"),
  "caret-right": () => import("@phosphor-icons/core/assets/regular/caret-right.svg?raw"),
  "caret-down": () => import("@phosphor-icons/core/assets/regular/caret-down.svg?raw"),
  "arrow-left": () => import("@phosphor-icons/core/assets/regular/arrow-left.svg?raw"),
  "clock-counter-clockwise": () =>
    import("@phosphor-icons/core/assets/regular/clock-counter-clockwise.svg?raw"),
  pencil: () => import("@phosphor-icons/core/assets/regular/pencil.svg?raw"),
  trash: () => import("@phosphor-icons/core/assets/regular/trash.svg?raw"),
  plus: () => import("@phosphor-icons/core/assets/regular/plus.svg?raw"),
} as const;

export type IconName = keyof typeof ICONS;

interface IconProps extends JSX.HTMLAttributes<HTMLSpanElement> {
  name: IconName;
  size?: number;
}

const cache = new Map<IconName, string>();

export default function Icon(props: IconProps) {
  const [local, rest] = splitProps(props, ["name", "size"]);
  let ref: HTMLSpanElement | undefined;

  createEffect(() => {
    const name = local.name;
    const size = local.size ?? 24;

    const cached = cache.get(name);
    if (cached) {
      applyIcon(ref, cached, size);
      return;
    }

    const currentName = name;
    void ICONS[name]().then((mod) => {
      const svg = mod.default as string;
      cache.set(currentName, svg);
      if (local.name === currentName && ref) {
        const currentSize = local.size ?? 24;
        applyIcon(ref, svg, currentSize);
      }
    });
  });

  return (
    <span ref={ref} class="icon" style={{ display: "inline-flex", "line-height": 0 }} {...rest} />
  );
}

function applyIcon(el: HTMLSpanElement | undefined, svg: string, size: number) {
  if (!el) return;
  el.innerHTML = svg;
  const svgEl = el.querySelector("svg");
  if (svgEl) {
    const s = `${size}px`;
    svgEl.setAttribute("width", s);
    svgEl.setAttribute("height", s);
  }
}
