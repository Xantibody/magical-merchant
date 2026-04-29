import { Show } from "solid-js";
import Icon from "./Icon";
import {
  parseTimelineEntry,
  getBatteryIcon,
  getNetworkIcon,
  getOsLabel,
  hasLocation,
} from "../lib/parse-timeline";

interface TimelineEntryProps {
  raw: string;
}

export default function TimelineEntry(props: TimelineEntryProps) {
  const parsed = () => parseTimelineEntry(props.raw);

  return (
    <div class="timeline-entry">
      <div class="timeline-entry-content">
        <Show when={parsed().time}>
          <span class="timeline-entry-time">{parsed().time}</span>
        </Show>
        <span class="timeline-entry-text">{parsed().text}</span>
      </div>
      <Show when={parsed().context}>
        {(ctx) => (
          <div class="timeline-entry-context">
            <Show when={getBatteryIcon(ctx())}>{(icon) => <Icon name={icon()} size={14} />}</Show>
            <Show when={getNetworkIcon(ctx())}>
              {(icon) => (
                <span class="timeline-context-item">
                  <Icon name={icon()} size={14} />
                  <Show when={ctx().wifi_ssid}>
                    <span class="timeline-context-label">{ctx().wifi_ssid}</span>
                  </Show>
                </span>
              )}
            </Show>
            <Show when={hasLocation(ctx())}>
              <Icon name="map-pin" size={14} />
            </Show>
            <Show when={getOsLabel(ctx())}>
              {(label) => (
                <span class="timeline-context-item">
                  <Icon name={ctx().os === "android" ? "device-mobile" : "laptop"} size={14} />
                  <span class="timeline-context-label">{label()}</span>
                </span>
              )}
            </Show>
            <Show when={ctx().hostname}>
              {(name) => <span class="timeline-context-label">{name()}</span>}
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
