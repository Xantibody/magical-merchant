import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { JSX } from "solid-js";
import { t } from "../lib/i18n";
import { scrubIndex, scrubYears } from "../lib/scrub";

interface ScrubberProps {
  /** Every day with a record, newest first: the whole span the thumb travels, not the loaded part. */
  dates: string[];
  /** The list it follows: where its topmost day sits is where the thumb rests. */
  scroller: () => HTMLElement | undefined;
  /** Let go on a day: the list goes there (loading it if it was not). */
  onJump: (iso: string) => void;
  /** A tap without a drag: the calendar, for the one exact day. */
  onCalendar: (trigger: HTMLElement) => void;
}

/** How long the thumb stays up after the list stops moving. */
const LINGER_MS = 1400;

function monthLabel(iso: string): string {
  const [year = 0, month = 1] = iso.split("-").map(Number);
  return t().calendar.monthTitle(year, month - 1);
}

/**
 * The thumb at Scrawl's right edge (22): drag it and a label says the month under the finger,
 * with the years marked down the track, and letting go lands on that day. Years of lines are
 * one stroke away instead of a long fling, and the thumb is where the thumb already is.
 * At rest it is a tab on the edge, never gone, so the days stay one visible press away: a tap
 * on it opens the calendar. While the list moves it draws out to a thumb.
 *
 * Pointer events with capture, not the palm's touch rule: the thumb is its own drag, and the
 * mouse uses the same thumb on a wide window.
 */
export default function ScrawlScrubber(props: ScrubberProps): JSX.Element {
  const [awake, setAwake] = createSignal(false);
  /** Where the thumb rests while no finger holds it, 0 at the newest day to 1 at the oldest. */
  const [resting, setResting] = createSignal(0);
  /** The fraction under the finger while it drags; null otherwise. */
  const [drag, setDrag] = createSignal<number | null>(null);
  let track: HTMLDivElement | undefined;
  let sleep: ReturnType<typeof setTimeout> | undefined;
  let moved = false;
  let startY = 0;

  const fraction = (): number => drag() ?? resting();
  const index = createMemo(() => scrubIndex(fraction(), props.dates.length));
  const day = (): string | undefined => props.dates[index()];
  const years = createMemo(() => scrubYears(props.dates));

  const wake = (): void => {
    setAwake(true);
    clearTimeout(sleep);
    sleep = setTimeout(() => {
      if (drag() === null) {
        setAwake(false);
      }
    }, LINGER_MS);
  };

  /** The topmost day still on screen, as the resting place along all the days. */
  const follow = (): void => {
    const scroller = props.scroller();
    if (!scroller || props.dates.length < 2) {
      return;
    }
    const { top } = scroller.getBoundingClientRect();
    const days = scroller.querySelectorAll<HTMLElement>("[data-day]");
    const current = [...days].find((el) => el.getBoundingClientRect().bottom > top + 8);
    const { day: iso = "" } = current?.dataset ?? {};
    const at = props.dates.indexOf(iso);
    setResting(Math.max(0, at) / (props.dates.length - 1));
    wake();
  };

  onMount(() => {
    const scroller = props.scroller();
    scroller?.addEventListener("scroll", follow, { passive: true });
    onCleanup(() => {
      scroller?.removeEventListener("scroll", follow);
      clearTimeout(sleep);
    });
  });

  const at = (clientY: number): number => {
    const box = track?.getBoundingClientRect();
    if (!box || box.height <= 0) {
      return 0;
    }
    return Math.min(1, Math.max(0, (clientY - box.top) / box.height));
  };

  return (
    <Show when={props.dates.length > 1}>
      <div
        class="scrubber"
        classList={{
          "scrubber--awake": awake() || drag() !== null,
          "scrubber--held": drag() !== null,
        }}
        ref={track}
        data-no-gesture
      >
        <Show when={drag() !== null}>
          <For each={years()}>
            {(mark) => (
              <span class="scrubber-year" style={{ top: `${mark.fraction * 100}%` }}>
                {mark.year}
              </span>
            )}
          </For>
        </Show>
        <button
          type="button"
          class="scrubber-thumb"
          style={{ top: `${fraction() * 100}%` }}
          title={t().palm.scrub}
          aria-label={`${t().palm.scrub}: ${day() ? monthLabel(day() ?? "") : ""}`}
          onPointerDown={(e) => {
            // Capture keeps the drag when the finger leaves the thin thumb; a pointer the
            // browser no longer knows (one already lifted) cannot be captured, and the drag
            // still works on the thumb itself
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              // Not captured: the moves over the thumb still arrive
            }
            moved = false;
            startY = e.clientY;
            setDrag(fraction());
            setAwake(true);
          }}
          onPointerMove={(e) => {
            if (drag() === null) {
              return;
            }
            if (Math.abs(e.clientY - startY) > 6) {
              moved = true;
            }
            if (moved) {
              setDrag(at(e.clientY));
            }
          }}
          onPointerUp={(e) => {
            const target = day();
            setDrag(null);
            wake();
            if (!moved) {
              props.onCalendar(e.currentTarget);
              return;
            }
            if (target) {
              setResting(index() / (props.dates.length - 1));
              props.onJump(target);
            }
          }}
          onPointerCancel={() => setDrag(null)}
        >
          <span class="scrubber-grip" aria-hidden="true" />
        </button>
        <Show when={drag() !== null && day()}>
          {(iso) => (
            <span class="scrubber-label" style={{ "--at": `${fraction() * 100}%` }}>
              {monthLabel(iso())}
            </span>
          )}
        </Show>
      </div>
    </Show>
  );
}
