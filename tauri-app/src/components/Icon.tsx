import { splitProps, createEffect } from "solid-js";
import type { JSX } from "solid-js";

const ICONS = {
  lightning: () => import("@phosphor-icons/core/assets/regular/lightning.svg?raw"),
  "note-pencil": () => import("@phosphor-icons/core/assets/regular/note-pencil.svg?raw"),
  "check-square": () => import("@phosphor-icons/core/assets/regular/check-square.svg?raw"),
  list: () => import("@phosphor-icons/core/assets/regular/list.svg?raw"),
  "paper-plane-tilt": () => import("@phosphor-icons/core/assets/regular/paper-plane-tilt.svg?raw"),
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

  createEffect(async () => {
    const name = local.name;
    const size = local.size ?? 24;
    let svg = cache.get(name);
    if (!svg) {
      const mod = await ICONS[name]();
      svg = mod.default as string;
      cache.set(name, svg!);
    }
    if (ref) {
      ref.innerHTML = svg!;
      const svgEl = ref.querySelector("svg");
      if (svgEl) {
        const s = `${size}px`;
        svgEl.setAttribute("width", s);
        svgEl.setAttribute("height", s);
      }
    }
  });

  return (
    <span
      ref={ref}
      class="icon"
      style={{ display: "inline-flex", "line-height": 0 }}
      {...rest}
    />
  );
}
