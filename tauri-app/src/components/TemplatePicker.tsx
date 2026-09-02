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
 * 一覧に添える代表タグ。ここでは変数を解いて見せる — 押せば今すぐ
 * ノートになる場所なので、知りたいのは「今日作ると何が付くか」。
 * テンプレの定義そのものを見る管理画面では逆に解かない。
 */
function badge(template: Template): string | undefined {
  const [first] = template.tags;
  return first === undefined ? undefined : resolveLine(first, new Date(), locale());
}

/**
 * 「新規」から開くテンプレ選択。PC ではボタンの下のドロップダウン、
 * 携帯では下から出るシートになる — 出方が違うだけで中身は同じなので、
 * 描くものは 1 つにして見せ方を CSS に預ける。
 */
export default function TemplatePicker(props: TemplatePickerProps): JSX.Element {
  return (
    <div class="popover template-picker" role="menu">
      {/* 携帯のシートだけが持つ掴み手と見出し。PC では隠れる */}
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
