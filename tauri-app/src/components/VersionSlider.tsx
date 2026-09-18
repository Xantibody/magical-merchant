import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { t } from "../lib/i18n";
import { isBeforeRestore, versionClock, versionDay } from "../lib/versions";
import type { VersionRow } from "../lib/versions";
import { NoVersions } from "./VersionSpine";
import "../styles/versions.css";

interface VersionSliderProps {
  /** 版。新しい順。 */
  rows: VersionRow[];
  selectedId: string | null;
  /** 履歴を開いた時刻。点の間隔はこれと最初の版のあいだで割る。 */
  now: Date;
  onSelect: (id: string) => void;
  onCommit: () => void;
}

/** 点と点の間の幅。時間に比例させるが、近すぎる 2 版が重ならない下限を置く。 */
const MIN_GAP = 0.12;

/** 点の名前。「版 4 · 09/10 09:12」 */
function label(row: VersionRow): string {
  const when = isBeforeRestore(row.version) ? t().codex.beforeRestore : versionDay(row.version);
  return `${t().codex.versionN(row.number)} · ${when} ${versionClock(row.version)}`;
}

/**
 * 背骨を横に倒したもの。並べる幅が無い画面(携帯・1099px 以下)で、履歴を
 * 開いたときに題の下へ出す。左から最古 → … → 最新 → 下書き(いま)。
 * 選んだ版だけが大きなつまみで、左右になぞるか点を押して版を送る。
 */
export default function VersionSlider(props: VersionSliderProps): JSX.Element {
  let track: HTMLDivElement | undefined;

  /** 古い順。描くのは左が過去。 */
  const ordered = (): VersionRow[] => props.rows.toReversed();

  /** 隣の点までの幅。最後は最新の版から「いま」まで。 */
  const gaps = (): number[] => {
    const rows = ordered();
    const [first] = rows;
    if (!first) {
      return [];
    }
    const start = new Date(first.version.time).getTime();
    const span = Math.max(props.now.getTime() - start, 1);
    const times = [...rows.map((row) => new Date(row.version.time).getTime()), props.now.getTime()];
    return times.slice(1).map((time, index) => {
      const before = times[index] ?? time;
      return Math.max((time - before) / span, MIN_GAP);
    });
  };

  const selected = (): VersionRow | undefined =>
    props.rows.find((row) => row.version.id === props.selectedId);

  /** 指の位置にいちばん近い点を選ぶ。押したまま動かせば次々に送れる。 */
  const pick = (clientX: number): void => {
    const dots = [...(track?.querySelectorAll<HTMLElement>(".version-slider-dot") ?? [])];
    let best: HTMLElement | undefined;
    let distance = Number.POSITIVE_INFINITY;
    for (const dot of dots) {
      const rect = dot.getBoundingClientRect();
      const gap = Math.abs(rect.left + rect.width / 2 - clientX);
      if (gap < distance) {
        distance = gap;
        best = dot;
      }
    }
    const id = best?.dataset.id;
    if (id && id !== props.selectedId) {
      props.onSelect(id);
    }
  };

  const onPointerDown = (e: PointerEvent): void => {
    track?.setPointerCapture(e.pointerId);
    pick(e.clientX);
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (track?.hasPointerCapture(e.pointerId)) {
      pick(e.clientX);
    }
  };

  return (
    <div class="version-slider" role="group" aria-label={t().codex.history}>
      <Show when={props.rows.length > 0} fallback={<NoVersions onCommit={props.onCommit} />}>
        <div
          ref={track}
          class="version-slider-track"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
        >
          <For each={ordered()}>
            {(row, index) => (
              <>
                <button
                  type="button"
                  class="version-slider-dot"
                  data-id={row.version.id}
                  aria-label={label(row)}
                  aria-current={row.version.id === props.selectedId}
                  onClick={() => props.onSelect(row.version.id)}
                />
                <span class="version-slider-gap" style={{ flex: String(gaps()[index()] ?? 1) }} />
              </>
            )}
          </For>
          <span class="version-dot" data-kind="draft" />
        </div>
        <div class="version-slider-labels">
          <span>
            {t().codex.monthOf(new Date(ordered()[0]?.version.time ?? props.now).getMonth() + 1)}
          </span>
          <span class="version-slider-current">
            <Show when={selected()}>{(row) => label(row())}</Show>
          </span>
          <span>{t().codex.now}</span>
        </div>
      </Show>
    </div>
  );
}
