/**
 * The pieces every Settings page is written in: a row, an on / off row, and a choice of
 * three or fewer.
 */

import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
// Kobalte is imported only from a per-route lazy chunk. Only the Settings route
// imports this module, so it stays out of the startup bundle
// (`.claude/skills/ui-design/SKILL.md`)
import { Switch } from "@kobalte/core/switch";
import { ToggleGroup } from "@kobalte/core/toggle-group";

/**
 * A choice of three or fewer. Not enough to justify a menu that opens to pick from.
 *
 * AIDEV-NOTE: do not add `data-key` inside a ToggleGroup. Kobalte looks up the
 * roving focus target by `[data-key]`, so it collides with the Cmd badge marker
 */
export function Seg<T extends string>(props: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onPick: (value: T) => void;
}): JSX.Element {
  return (
    <ToggleGroup
      class="settings-seg"
      aria-label={props.label}
      value={props.value}
      // Pressing the selected item again makes Kobalte return null. Settings has
      // no "nothing selected" state, so that report is dropped
      onChange={(value) => {
        if (value !== null) {
          props.onPick(value as T);
        }
      }}
    >
      <For each={props.options}>
        {([value, label]) => (
          <ToggleGroup.Item class="settings-seg-item" value={value}>
            {label}
          </ToggleGroup.Item>
        )}
      </For>
    </ToggleGroup>
  );
}

/**
 * One Settings row. Label and description on the left, the control on the right.
 * Only a row given `labelFor` gets a real `<label>` as its label: `for` has no
 * effect on a ToggleGroup or a group of switches, so only rows with a field get one.
 */
export function Row(props: {
  label: string;
  desc?: string;
  labelFor?: string;
  /** A tall control (glyph management, Workers URL) is aligned to the top edge. */
  tall?: boolean;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div class="settings-row" classList={{ "settings-row--tall": props.tall }}>
      <div class="settings-row-head">
        <Show when={props.labelFor} fallback={<div class="settings-row-label">{props.label}</div>}>
          {(field) => (
            <label class="settings-row-label" for={field()}>
              {props.label}
            </label>
          )}
        </Show>
        <Show when={props.desc}>{(desc) => <p class="settings-row-desc">{desc()}</p>}</Show>
      </div>
      <div class="settings-row-control">{props.children}</div>
    </div>
  );
}

/** An on / off row. The Kobalte Switch is the row itself. */
export function SwitchRow(props: {
  label: string;
  desc: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}): JSX.Element {
  return (
    <Switch
      class="settings-row"
      checked={props.checked}
      onChange={(checked) => props.onChange(checked)}
    >
      <div class="settings-row-head">
        <Switch.Label class="settings-row-label">{props.label}</Switch.Label>
        <Switch.Description class="settings-row-desc">{props.desc}</Switch.Description>
      </div>
      <Switch.Input />
      <div class="settings-row-control">
        <Switch.Control class="settings-switch">
          <Switch.Thumb class="settings-switch-thumb" />
        </Switch.Control>
      </div>
    </Switch>
  );
}
