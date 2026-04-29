import { Show } from "solid-js";
import Icon from "./Icon";
import {
  parseTimelineEntry,
  getBatteryIcon,
  getNetworkIcon,
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
            <Show when={getNetworkIcon(ctx())}>{(icon) => <Icon name={icon()} size={14} />}</Show>
            <Show when={hasLocation(ctx())}>
              <Icon name="map-pin" size={14} />
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
