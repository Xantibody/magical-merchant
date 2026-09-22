import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import { t, locale } from "../lib/i18n";
import { resolveLine } from "../lib/template-vars";
import type { Template } from "../lib/commands";
import "../styles/templates.css";

interface TemplatePickerProps {
  templates: Template[];
  onPickEmpty: () => void;
  onPick: (template: Template) => void;
  onManage: () => void;
}

/**
 * The representative tag set beside a row. Here the variables are resolved before being
 * shown: this is the place where a press becomes a note right away, so what matters is what
 * would be attached if it were created today. The management screen, which looks at the
 * template's definition itself, does not resolve them.
 */
function badge(template: Template): string | undefined {
  const [first] = template.tags;
  return first === undefined ? undefined : resolveLine(first, new Date(), locale());
}

/**
 * The template picker opened from "new". On desktop it is a dropdown under the button; on a
 * phone it is a sheet rising from the bottom. Only the way it appears differs, the contents
 * are the same, so one thing is rendered and the presentation is left to CSS.
 */
export default function TemplatePicker(props: TemplatePickerProps): JSX.Element {
  return (
    <div class="popover template-picker" role="menu">
      {/* The grab handle and heading that only the phone sheet has. Hidden on desktop */}
      <div class="template-picker-handle" aria-hidden="true" />
      <div class="template-picker-title">{t().templates.newNote}</div>

      <button type="button" class="template-picker-row" role="menuitem" onClick={props.onPickEmpty}>
        <Icon name="note-pencil" size={14} />
        <span class="template-picker-name">{t().templates.emptyNote}</span>
        <span class="key-badge template-picker-key">⌘N</span>
      </button>

      <Show when={props.templates.length > 0}>
        <div class="template-picker-section">{t().templates.fromTemplate}</div>
        <For each={props.templates}>
          {(template) => (
            <button
              type="button"
              class="template-picker-row"
              role="menuitem"
              onClick={() => props.onPick(template)}
            >
              <Icon name="file-text" size={14} />
              <span class="template-picker-name">{template.name}</span>
              <Show when={badge(template)}>{(tag) => <span class="tag-badge">#{tag()}</span>}</Show>
            </button>
          )}
        </For>
      </Show>

      <div class="template-picker-divider" />

      <button
        type="button"
        class="template-picker-row template-picker-manage"
        role="menuitem"
        onClick={props.onManage}
      >
        <Icon name="gear" size={12} />
        <span class="template-picker-name">{t().templates.manageLink}</span>
      </button>
    </div>
  );
}
