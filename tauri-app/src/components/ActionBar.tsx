import type { JSX } from "solid-js";

interface ActionBarProps {
  children: JSX.Element;
}

export default function ActionBar(props: ActionBarProps) {
  return (
    <div class="action-bar-zone">
      <div class="action-bar">{props.children}</div>
    </div>
  );
}
