import { type Accessor } from "solid-js";
import { A } from "@solidjs/router";
import Icon from "./Icon";
import { ROUTES, MODE_ICONS, MODE_LABELS } from "../lib/routes";

interface ToggleMenuProps {
  isOpen: Accessor<boolean>;
  onClose: () => void;
}

export default function ToggleMenu(props: ToggleMenuProps) {
  return (
    <nav class="toggle-menu" classList={{ open: props.isOpen() }}>
      <A href={ROUTES.TIMELINE} class="toggle-menu-item" activeClass="active" end onClick={props.onClose}>
        <Icon name={MODE_ICONS[ROUTES.TIMELINE]} size={20} />
        {MODE_LABELS[ROUTES.TIMELINE]}
      </A>
      <A href={ROUTES.NOTES} class="toggle-menu-item" activeClass="active" onClick={props.onClose}>
        <Icon name={MODE_ICONS[ROUTES.NOTES]} size={20} />
        {MODE_LABELS[ROUTES.NOTES]}
      </A>
      <A href={ROUTES.TASKS} class="toggle-menu-item" activeClass="active" onClick={props.onClose}>
        <Icon name={MODE_ICONS[ROUTES.TASKS]} size={20} />
        {MODE_LABELS[ROUTES.TASKS]}
      </A>
      <A href={ROUTES.SETTINGS} class="toggle-menu-item" activeClass="active" onClick={props.onClose}>
        <Icon name={MODE_ICONS[ROUTES.SETTINGS]} size={20} />
        {MODE_LABELS[ROUTES.SETTINGS]}
      </A>
    </nav>
  );
}
