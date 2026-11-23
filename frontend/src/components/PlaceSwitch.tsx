import {
  createComputed,
  createEffect,
  createResource,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { JSX } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import Icon from "./Icon";
import { createRingPress } from "./Ring";
import type { RingPlace } from "./Ring";
import { typedInvoke } from "../lib/commands";
import type { NoteKind } from "../lib/commands";
import { toIsoDate } from "../lib/day-labels";
import { t } from "../lib/i18n";
import { noteRoute } from "../lib/note-route";
import type { RingChoice } from "../lib/ring";
import { MODE_ICONS, MODE_LABELS, ROUTES } from "../lib/routes";
import { useShell } from "../lib/shell";

/** The three surfaces, in the order of ⌘1/2/3 and a wide window's shelf. */
const SURFACES = [ROUTES.SCRAWL, ROUTES.NOTES, ROUTES.CODEX] as const;

/** The surface a note kind lives on. */
const KIND_OF: Partial<Record<string, NoteKind>> = {
  [ROUTES.NOTES]: "note",
  [ROUTES.CODEX]: "codex",
};

interface PlaceSwitchProps {
  /** Scrawl: the pill reaches across to the right gutter and its slot holds the field. */
  stretched?: boolean;
  /** Hands over the element a surface portals its own controls into, and nothing on unmount. */
  slot?: (slot?: HTMLElement) => void;
  /** How far an on-screen keyboard reaches into the window (`lib/keyboard-inset.ts`). */
  lift?: number;
  /** Folded away while reading; the line of words stands in its place (AppLayout). */
  slim?: boolean;
  /** The ring's petals for a held press (`lib/ring.ts`): what the app can start from here. */
  choices: RingChoice[];
}

/**
 * Plays a change of shape that has already been laid out, from how it looked before: the
 * starting frame is set with no transition, committed, then let go so the sheet's transition
 * carries it home. Motion stays in CSS, so the reduced-motion rule in base.css covers it too.
 */
function playFrom(el: HTMLElement, from: Partial<Record<"transform" | "opacity", string>>): void {
  el.style.transition = "none";
  Object.assign(el.style, from);
  // Reading the layout commits the starting frame; without it the browser folds both writes
  el.getBoundingClientRect();
  el.style.transition = "";
  el.style.transform = "";
  el.style.opacity = "";
}

/**
 * A phone's way between the three surfaces, low on the left under the thumb: one floating
 * pill. On a list it is compact, opposite the compose button; on Scrawl the same pill
 * stretches to the right gutter and the stretched part is where records are written.
 *
 * A tap is a place; a held press is the ring (`Ring.tsx`), because a thumb on the pill is the
 * cheapest thing in the app (the leading idea: nobody hunts for buttons):
 * - Note and Codex, tapped, go straight back to the note last open there (93). On the surface
 *   already, a tap is the list, the way a tab bar pops to its root.
 * - Held anywhere on the pill, the ring blooms over it: a line into Scrawl over whatever is open
 *   (68), a new Note or Codex, or one from a template (65). Slid along the pill instead,
 *   the place under the thumb is let go on for its list (93's hold).
 * - Scrawl carries today's count on itself (92), so how much the day holds needs no other place.
 *
 * The shell mounts it (AppLayout), not each surface, so moving between Scrawl and a list keeps
 * the element and the stretch can be seen. Its width is laid out, not animated: the ground
 * under the buttons is played from its old width by `scaleX` (transform only, per the motion
 * rule), and the field fades in once the ground is on its way.
 */
export default function PlaceSwitch(props: PlaceSwitchProps): JSX.Element {
  const shell = useShell();
  const location = useLocation();
  const navigate = useNavigate();
  const here = (path: string): boolean => location.pathname === path;

  // Today's lines: one day file, reread whenever a record is written or the data comes back
  const [today] = createResource(
    () => `${shell.dataVersion()}:${shell.recordsVersion()}`,
    async () => {
      try {
        const lines = await typedInvoke("read_scrawl_by_date", { date: toIsoDate(new Date()) });
        return lines.length;
      } catch {
        return 0;
      }
    },
  );

  /** To the list of a surface: from its open note one level back, from elsewhere its route. */
  const toList = (path: string): void => {
    if (here(path)) {
      shell.headerBack()?.();
      return;
    }
    navigate(path);
  };

  const tap = (path: string): void => {
    const kind = KIND_OF[path];
    if (here(path)) {
      // Pressing where you are would drop the list's query (the selected note); on a note it
      // is the way up to the list instead
      if (kind) {
        toList(path);
      }
      return;
    }
    const last = kind ? shell.lastNote()[kind] : undefined;
    navigate(kind && last ? noteRoute(kind, last) : path);
  };

  /** The place buttons, read under a slide while the ring is up. */
  const buttons = new Map<string, HTMLButtonElement>();

  /**
   * A slide along the pill while the ring stands (93's hold, folded into the ring): the place
   * under the thumb is its list, the way a held Note or Codex was. Scrawl is its own list.
   */
  const placeAt = (x: number, y: number): RingPlace | null => {
    for (const [path, button] of buttons) {
      const box = button.getBoundingClientRect();
      if (x >= box.left && x <= box.right && y >= box.top - 8 && y <= box.bottom + 8) {
        const name = MODE_LABELS[path as (typeof SURFACES)[number]];
        return {
          id: path,
          label: path === ROUTES.SCRAWL ? name : t().reach.placeList(name),
          run: () => toList(path),
        };
      }
    }
    return null;
  };

  /**
   * The pill held (65, 68, 93 in one gesture): the ring blooms where the thumb is. A tap is
   * still the place itself, so the ring waits for the press to stay still a moment.
   */
  const ring = createRingPress({
    choices: () => props.choices,
    holdMs: 320,
    placeAt,
    // The whole pill stays lit through the veil: the slide along it is half of this gesture
    spot: () => [...buttons.values()][0]?.closest<HTMLElement>(".place-switch") ?? undefined,
  });

  const label = (path: (typeof SURFACES)[number]): string => {
    const name = MODE_LABELS[path];
    if (path === ROUTES.SCRAWL) {
      const count = today.latest ?? 0;
      return count > 0 ? `${name} · ${t().palm.today(count)}` : name;
    }
    return `${name} · ${t().reach.ringHint}`;
  };

  let ground: HTMLSpanElement | undefined;
  let slot: HTMLDivElement | undefined;
  /** The ground's width before the change, measured before the new class is drawn. */
  let fromWidth = 0;

  // A computation runs before the render effect that swaps the class, so this still sees the
  // old shape
  createComputed(
    on(
      () => props.stretched,
      () => {
        fromWidth = ground?.getBoundingClientRect().width ?? 0;
      },
      { defer: true },
    ),
  );
  // An effect runs after it, on the new shape. Only a change plays: the pill that opens the app
  // already stretched on Scrawl stands still, so the field is there the moment it opens
  createEffect(
    on(
      () => props.stretched,
      (stretched) => {
        const toWidth = ground?.getBoundingClientRect().width ?? 0;
        if (ground && fromWidth > 0 && toWidth > 0 && fromWidth !== toWidth) {
          playFrom(ground, { transform: `scaleX(${fromWidth / toWidth})` });
        }
        if (stretched && slot) {
          playFrom(slot, { opacity: "0" });
        }
      },
      { defer: true },
    ),
  );

  onCleanup(() => props.slot?.());

  /**
   * How high the pill reaches over the window's foot, for whatever must stand clear above it: a
   * toast lands over a five-line draft otherwise. Measured, not reckoned, since the field grows
   * line by line and rides the keyboard (palm.css reads `--dock-top`).
   */
  let pill: HTMLDivElement | undefined;
  const root = document.documentElement;
  const measure = (): void => {
    const app = pill?.closest(".app");
    if (!pill || !app) {
      return;
    }
    const reach = app.getBoundingClientRect().bottom - pill.getBoundingClientRect().top;
    root.style.setProperty("--dock-top", `${Math.round(reach)}px`);
  };
  onMount(() => {
    const watch = new ResizeObserver(measure);
    if (pill) {
      watch.observe(pill);
    }
    onCleanup(() => {
      watch.disconnect();
      root.style.removeProperty("--dock-top");
    });
  });
  createEffect(
    on(
      () => props.lift,
      () => queueMicrotask(measure),
      { defer: true },
    ),
  );

  return (
    <div
      ref={pill}
      class="place-switch"
      classList={{
        "place-switch--stretched": props.stretched,
        "place-switch--slim": props.slim,
        // Over the ring's dimmed page while it stands: a slide along it picks a place
        "place-switch--ring": ring.open(),
      }}
      style={{ "--keyboard-lift": `${props.lift ?? 0}px` }}
      inert={props.slim}
    >
      <span class="place-switch-ground" ref={ground} aria-hidden="true" />
      <nav class="place-switch-places" aria-label={t().library.places}>
        <For each={SURFACES}>
          {(path) => (
            <button
              type="button"
              class="place-switch-button ring-trigger"
              classList={{
                "place-switch-button--here": here(path),
                "place-switch-button--aimed": ring.place()?.id === path,
              }}
              title={label(path)}
              aria-label={label(path)}
              aria-current={here(path) ? "page" : undefined}
              ref={(el) => buttons.set(path, el)}
              {...ring.handlers}
              onClick={() => {
                if (ring.shouldClick()) {
                  tap(path);
                }
              }}
            >
              <Icon name={MODE_ICONS[path]} size={22} />
              <Show when={path === ROUTES.SCRAWL && (today.latest ?? 0) > 0}>
                <span class="place-switch-count" aria-hidden="true">
                  {today.latest}
                </span>
              </Show>
            </button>
          )}
        </For>
      </nav>
      <div
        class="place-switch-slot"
        ref={(el) => {
          slot = el;
          props.slot?.(el);
        }}
      />
      {ring.view()}
    </div>
  );
}
