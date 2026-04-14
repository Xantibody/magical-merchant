import { type Accessor } from "solid-js";
import { A } from "@solidjs/router";

interface ToggleMenuProps {
  isOpen: Accessor<boolean>;
  onClose: () => void;
}

export default function ToggleMenu(props: ToggleMenuProps) {
  return (
    <nav class="toggle-menu" classList={{ open: props.isOpen() }}>
      <A href="/" class="toggle-menu-item" onClick={props.onClose}>
        Timeline
      </A>
      <A href="/notes" class="toggle-menu-item" onClick={props.onClose}>
        Notes
      </A>
      <A href="/tasks" class="toggle-menu-item" onClick={props.onClose}>
        Tasks
      </A>
    </nav>
  );
}
