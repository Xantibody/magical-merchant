import { createSignal, createMemo, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import {
  buildMonthGrid,
  formatMonthTitle,
  shiftMonth,
  WEEKDAY_LABELS,
  summarizeDay,
} from "../lib/calendar";
import type { DaySummary } from "../lib/calendar";
import { toIsoDate } from "../lib/day-labels";
import type { DeviceContext } from "../lib/parse-timeline";

interface CalendarPopoverProps {
  /** 記録のある日 (`YYYY-MM-DD`)。太字で示す。 */
  recordedDates: string[];
  /** 選択日のコンテキスト。集計に使う。 */
  contextsFor: (iso: string) => (DeviceContext | null)[];
  onPick: (iso: string) => void;
}

export default function CalendarPopover(props: CalendarPopoverProps): JSX.Element {
  const today = new Date();
  const [year, setYear] = createSignal(today.getFullYear());
  const [month, setMonth] = createSignal(today.getMonth());
  const [picked, setPicked] = createSignal(toIsoDate(today));

  const todayIso = toIsoDate(today);
  const recorded = createMemo(() => new Set(props.recordedDates));
  const grid = createMemo(() => buildMonthGrid(year(), month()));
  const summary = createMemo<DaySummary>(() => summarizeDay(props.contextsFor(picked())));

  const step = (delta: number): void => {
    const [nextYear, nextMonth] = shiftMonth(year(), month(), delta);
    setYear(nextYear);
    setMonth(nextMonth);
  };

  const pickedLabel = createMemo(() => {
    const [, m, d] = picked().split("-");
    return `${Number(m)}月${Number(d)}日`;
  });

  return (
    <div class="popover calendar-popover">
      <div class="calendar-header">
        <button type="button" class="icon-button" aria-label="前の月" onClick={() => step(-1)}>
          <Icon name="caret-left" size={14} />
        </button>
        <span class="calendar-title">{formatMonthTitle(year(), month())}</span>
        <button type="button" class="icon-button" aria-label="次の月" onClick={() => step(1)}>
          <Icon name="caret-right" size={14} />
        </button>
      </div>

      <div class="calendar-grid">
        <For each={WEEKDAY_LABELS}>{(label) => <span class="calendar-weekday">{label}</span>}</For>
        <For each={grid()}>
          {(cell) => (
            <button
              type="button"
              class="calendar-day"
              classList={{
                "calendar-day--outside": !cell.inMonth,
                "calendar-day--recorded": recorded().has(cell.iso),
                "calendar-day--today": cell.iso === todayIso,
                "calendar-day--picked": cell.iso === picked(),
              }}
              onClick={() => {
                setPicked(cell.iso);
                props.onPick(cell.iso);
              }}
            >
              {cell.day}
            </button>
          )}
        </For>
      </div>

      <div class="calendar-summary">
        <span class="calendar-summary-title">
          {pickedLabel()} — {summary().count}件
        </span>
        <Show when={summary().count > 0}>
          <span class="calendar-summary-row">
            <Show when={summary().places.length}>
              <span class="calendar-summary-item">
                <Icon name="map-pin" size={13} />
                {summary()
                  .places.map((p) => `${p.label} ${p.count}`)
                  .join(" · ")}
              </span>
            </Show>
            <For each={summary().devices}>
              {(device) => (
                <span class="calendar-summary-item">
                  <Icon name={device.label === "android" ? "device-mobile" : "laptop"} size={13} />
                  {device.count}
                </span>
              )}
            </For>
          </span>
        </Show>
      </div>
    </div>
  );
}
