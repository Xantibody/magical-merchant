import { type Accessor } from "solid-js";
import { A } from "@solidjs/router";
import Icon from "./Icon";

interface ToggleMenuProps {
  isOpen: Accessor<boolean>;
  onClose: () => void;
}

export default function ToggleMenu(props: ToggleMenuProps) {
  return (
    <nav class="toggle-menu" classList={{ open: props.isOpen() }}>
      <A href="/" class="toggle-menu-item" onClick={props.onClose}>
        <Icon name="lightning" size={20} />
        Timeline
      </A>
      <A href="/notes" class="toggle-menu-item" onClick={props.onClose}>
        <Icon name="note-pencil" size={20} />
        Notes
      </A>
      <A href="/tasks" class="toggle-menu-item" onClick={props.onClose}>
        <Icon name="check-square" size={20} />
        Tasks
      </A>
    </nav>
  );
}
