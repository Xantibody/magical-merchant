import { type JSX, createSignal, onMount, onCleanup } from "solid-js";

interface ActionBarProps {
  children: JSX.Element;
}

const FLICK_DISTANCE = 30;
const FLICK_MAX_DURATION = 300;

export default function ActionBar(props: ActionBarProps) {
  const [visible, setVisible] = createSignal(false);
  let barRef!: HTMLDivElement;

  let touchStartY = 0;
  let touchStartTime = 0;

  const onTouchStart = (e: TouchEvent) => {
    touchStartY = e.touches[0].clientY;
    touchStartTime = Date.now();
  };

  const onTouchEnd = (e: TouchEvent) => {
    const deltaY = e.changedTouches[0].clientY - touchStartY;
    const elapsed = Date.now() - touchStartTime;

    if (Math.abs(deltaY) >= FLICK_DISTANCE && elapsed <= FLICK_MAX_DURATION) {
      setVisible(deltaY < 0);
    }
  };

  const onDocumentTouchStart = (e: TouchEvent) => {
    if (visible() && !barRef.contains(e.target as Node)) {
      setVisible(false);
    }
  };

  onMount(() => {
    document.addEventListener("touchstart", onDocumentTouchStart);
  });
  onCleanup(() => {
    document.removeEventListener("touchstart", onDocumentTouchStart);
  });

  return (
    <div class="action-bar-zone" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <div class="action-bar" classList={{ "action-bar--visible": visible() }} ref={barRef}>
        {props.children}
      </div>
    </div>
  );
}
