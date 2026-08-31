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
  "circle-half": () => import("@phosphor-icons/core/assets/regular/circle-half.svg?raw"),
  "caret-right": () => import("@phosphor-icons/core/assets/regular/caret-right.svg?raw"),
  "caret-down": () => import("@phosphor-icons/core/assets/regular/caret-down.svg?raw"),
  "arrow-left": () => import("@phosphor-icons/core/assets/regular/arrow-left.svg?raw"),
  "arrow-line-down": () => import("@phosphor-icons/core/assets/regular/arrow-line-down.svg?raw"),
  "clock-counter-clockwise": () =>
    import("@phosphor-icons/core/assets/regular/clock-counter-clockwise.svg?raw"),
  pencil: () => import("@phosphor-icons/core/assets/regular/pencil.svg?raw"),
  trash: () => import("@phosphor-icons/core/assets/regular/trash.svg?raw"),
  plus: () => import("@phosphor-icons/core/assets/regular/plus.svg?raw"),
  "cloud-check": () => import("@phosphor-icons/core/assets/regular/cloud-check.svg?raw"),
  "cloud-arrow-up": () => import("@phosphor-icons/core/assets/regular/cloud-arrow-up.svg?raw"),
  "cloud-slash": () => import("@phosphor-icons/core/assets/regular/cloud-slash.svg?raw"),
  "cloud-warning": () => import("@phosphor-icons/core/assets/regular/cloud-warning.svg?raw"),
  gear: () => import("@phosphor-icons/core/assets/regular/gear.svg?raw"),
  "battery-full": () => import("@phosphor-icons/core/assets/regular/battery-full.svg?raw"),
  "battery-high": () => import("@phosphor-icons/core/assets/regular/battery-high.svg?raw"),
  "battery-medium": () => import("@phosphor-icons/core/assets/regular/battery-medium.svg?raw"),
  "battery-low": () => import("@phosphor-icons/core/assets/regular/battery-low.svg?raw"),
  "battery-empty": () => import("@phosphor-icons/core/assets/regular/battery-empty.svg?raw"),
  "battery-charging": () => import("@phosphor-icons/core/assets/regular/battery-charging.svg?raw"),
  "wifi-high": () => import("@phosphor-icons/core/assets/regular/wifi-high.svg?raw"),
  "wifi-slash": () => import("@phosphor-icons/core/assets/regular/wifi-slash.svg?raw"),
  "cell-signal-full": () => import("@phosphor-icons/core/assets/regular/cell-signal-full.svg?raw"),
  network: () => import("@phosphor-icons/core/assets/regular/network.svg?raw"),
  "map-pin": () => import("@phosphor-icons/core/assets/regular/map-pin.svg?raw"),
  laptop: () => import("@phosphor-icons/core/assets/regular/laptop.svg?raw"),
  "device-mobile": () => import("@phosphor-icons/core/assets/regular/device-mobile.svg?raw"),
  "text-indent": () => import("@phosphor-icons/core/assets/regular/text-indent.svg?raw"),
  "text-outdent": () => import("@phosphor-icons/core/assets/regular/text-outdent.svg?raw"),
  "code-block": () => import("@phosphor-icons/core/assets/regular/code-block.svg?raw"),
  minus: () => import("@phosphor-icons/core/assets/regular/minus.svg?raw"),
  "magnifying-glass": () => import("@phosphor-icons/core/assets/regular/magnifying-glass.svg?raw"),
  "calendar-blank": () => import("@phosphor-icons/core/assets/regular/calendar-blank.svg?raw"),
  info: () => import("@phosphor-icons/core/assets/regular/info.svg?raw"),
  x: () => import("@phosphor-icons/core/assets/regular/x.svg?raw"),
  check: () => import("@phosphor-icons/core/assets/regular/check.svg?raw"),
  circle: () => import("@phosphor-icons/core/assets/regular/circle.svg?raw"),
  "check-circle": () => import("@phosphor-icons/core/assets/regular/check-circle.svg?raw"),
  "file-text": () => import("@phosphor-icons/core/assets/regular/file-text.svg?raw"),
  "tree-structure": () => import("@phosphor-icons/core/assets/regular/tree-structure.svg?raw"),
  "caret-left": () => import("@phosphor-icons/core/assets/regular/caret-left.svg?raw"),
  "brackets-curly": () => import("@phosphor-icons/core/assets/regular/brackets-curly.svg?raw"),
} as const;

export type IconName = keyof typeof ICONS;

interface IconProps extends JSX.HTMLAttributes<HTMLSpanElement> {
  name: IconName;
  size?: number;
}

const cache = new Map<IconName, string>();

function applyIcon(el: HTMLSpanElement | undefined, svg: string, size: number) {
  if (!el) {
    return;
  }
  el.innerHTML = svg;
  const svgEl = el.querySelector("svg");
  if (svgEl) {
    const s = `${size}px`;
    svgEl.setAttribute("width", s);
    svgEl.setAttribute("height", s);
  }
}

export default function Icon(props: IconProps): JSX.Element {
  const [local, rest] = splitProps(props, ["name", "size"]);
  let ref: HTMLSpanElement | undefined;

  createEffect(() => {
    const { name } = local;
    const size = local.size ?? 24;

    const cached = cache.get(name);
    if (cached) {
      applyIcon(ref, cached, size);
      return;
    }

    const currentName = name;
    void (async () => {
      const mod = await ICONS[currentName]();
      const svg = mod.default as string;
      cache.set(currentName, svg);
      if (local.name === currentName && ref) {
        applyIcon(ref, svg, local.size ?? 24);
      }
    })();
  });

  return (
    <span
      ref={ref}
      class="icon"
      // SVG が動的 import で届く前から枠を予約しておく。空の span を 0px の
      // ままにすると、届いた瞬間にヘッダやタブバーが育って画面全体が揺れる
      style={{
        display: "inline-flex",
        "line-height": 0,
        width: `${local.size ?? 24}px`,
        height: `${local.size ?? 24}px`,
      }}
      {...rest}
    />
  );
}
