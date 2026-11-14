import { createSignal, onCleanup, Show } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import type { IconName } from "./Icon";

/** How long the press has to last. Long enough not to happen by a brush, short enough not to wait. */
const HOLD_MS = 800;

interface HoldButtonProps {
  label: string;
  icon?: IconName;
  /** What the button asks for while it has not been held: "hold to delete". */
  hint: string;
  onConfirm: () => void;
  class?: string;
  disabled?: boolean;
  /** Drawn in the danger colours (delete). Otherwise the accent fills it. */
  danger?: boolean;
  /** -1 where the same action has another way in for the keys (a row's hidden actions). */
  tabIndex?: number;
}

/**
 * A button that does its thing only when held (96): the fill grows from the left while it is
 * pressed and the action runs the moment it is full. Letting go early drains it and says how
 * it works. It stands in for a confirmation dialog: the question and the answer are the same
 * hand on the same spot, so nothing opens over the page and the thumb does not travel.
 *
 * The fill is drawn frame by frame from the elapsed time, not by a transition: it is a gauge of
 * the press, not motion, and it has to stop exactly where the finger lifts. Holding Enter or
 * Space does the same from the keyboard.
 */
export default function HoldButton(props: HoldButtonProps): JSX.Element {
  const [progress, setProgress] = createSignal(0);
  /** Said for a moment after a press too short to count. */
  const [told, setTold] = createSignal(false);
  let started = 0;
  let frame = 0;
  let toldTimer: ReturnType<typeof setTimeout> | undefined;

  const stop = (): void => {
    cancelAnimationFrame(frame);
    frame = 0;
  };

  const tick = (now: number): void => {
    const p = Math.min(1, (now - started) / HOLD_MS);
    setProgress(p);
    if (p >= 1) {
      stop();
      setProgress(0);
      // A tick of the motor where the device has one: the press has gone through
      globalThis.navigator?.vibrate?.(12);
      props.onConfirm();
      return;
    }
    frame = requestAnimationFrame(tick);
  };

  const press = (): void => {
    if (props.disabled || frame) {
      return;
    }
    clearTimeout(toldTimer);
    setTold(false);
    started = performance.now();
    frame = requestAnimationFrame(tick);
  };

  const release = (): void => {
    if (!frame) {
      return;
    }
    stop();
    if (progress() > 0) {
      setTold(true);
      clearTimeout(toldTimer);
      toldTimer = setTimeout(() => setTold(false), 1800);
    }
    setProgress(0);
  };

  onCleanup(() => {
    stop();
    clearTimeout(toldTimer);
  });

  /**
   * The words on it: its name, and how it works once a press too short has been let go. While
   * held it keeps its name; the fill is what speaks then, and a longer line would not fit the
   * narrow buttons behind a row.
   */
  const words = (): string => (told() ? props.hint : props.label);

  return (
    <button
      type="button"
      class={`hold-button long-press ${props.class ?? ""}`}
      classList={{ "hold-button--danger": props.danger === true, "hold-button--told": told() }}
      disabled={props.disabled}
      tabIndex={props.tabIndex}
      aria-label={`${props.label} (${props.hint})`}
      title={props.hint}
      onPointerDown={(e) => {
        // A finger held still on a button is the start of a text selection to the WebView
        if (e.pointerType !== "mouse") {
          e.preventDefault();
        }
        press();
      }}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
          e.preventDefault();
          press();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          release();
        }
      }}
      onBlur={release}
    >
      <span
        class="hold-button-fill"
        aria-hidden="true"
        style={{ transform: `scaleX(${progress()})` }}
      />
      <Show when={props.icon}>{(name) => <Icon name={name()} size={15} />}</Show>
      <span class="hold-button-label">{words()}</span>
    </button>
  );
}
