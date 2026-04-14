import { splitProps } from "solid-js";
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

  const load = async () => {
    let svg = cache.get(local.name);
    if (!svg) {
      const mod = await ICONS[local.name]();
      svg = mod.default;
      cache.set(local.name, svg);
    }
    if (ref) {
      ref.innerHTML = svg;
      const svgEl = ref.querySelector("svg");
      if (svgEl) {
        const s = `${local.size ?? 24}px`;
        svgEl.setAttribute("width", s);
        svgEl.setAttribute("height", s);
      }
    }
  };

  load();

  return (
    <span
      ref={ref}
      class="icon"
      style={{ display: "inline-flex", "line-height": 0 }}
      {...rest}
    />
  );
}
