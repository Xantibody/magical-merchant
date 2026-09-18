import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import { t } from "../lib/i18n";
import { shortcutLabel } from "../lib/shortcuts";
import { isBeforeRestore, versionClock, versionDay } from "../lib/versions";
import type { VersionRow } from "../lib/versions";
import "../styles/versions.css";

interface VersionSpineProps {
  /** 版。新しい順。 */
  rows: VersionRow[];
  /** 最新の版から下書きが動いているか。 */
  dirty: boolean;
  /** 下書きと最新の版のバイト差。 */
  bytesDelta: number;
  /**
   * 200px に広げて行を出しているか。閉じていても 56px の列として残る。
   * 並べる幅が無い画面では履歴を開いても広げず、カードが版を送る。
   */
  open: boolean;
  /** 履歴で選んでいる版。開いているあいだは畳んだ列の点もこれを塗る。 */
  selectedId: string | null;
  /** 選んだ版が下書きと同じ(欄外の印がゼロ)。 */
  same: boolean;
  /** 読み取り専用のノートには戻せない。 */
  readOnly: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSelect: (id: string) => void;
  onRestore: (id: string) => void;
  onCommit: () => void;
}

/** ↑↓ で背骨の行を送る向き。 */
const ROW_STEP_KEYS: Readonly<Record<string, 1 | -1>> = { ArrowUp: -1, ArrowDown: 1 };

/** 行の 1 行目。「版 4 · 09/10」、戻す前に刻んだ版は日付の代わりにそう名乗る。 */
function firstLine(row: VersionRow): string {
  const when = isBeforeRestore(row.version) ? t().codex.beforeRestore : versionDay(row.version);
  return `${t().codex.versionN(row.number)} · ${when}`;
}

/** 点の種類。下書きは中空、強調(開いていれば選択中、畳んでいれば最新)は塗り。 */
function Dot(props: { kind: "draft" | "strong" | "faint" }): JSX.Element {
  return <span class="version-dot" data-kind={props.kind} />;
}

/**
 * 版ゼロの Codex で履歴を開いたとき。空の一覧を見せる代わりに、次の一手
 * (刻む)をここに置く。横向きのカードも同じものを出す。
 */
export function NoVersions(props: { onCommit: () => void }): JSX.Element {
  return (
    <div class="version-empty">
      <p class="version-empty-hint">{t().codex.noVersionsHint}</p>
      <button type="button" class="button-secondary" onClick={() => props.onCommit()}>
        <Icon name="book-bookmark" size={14} />
        {t().codex.commit}
        <kbd class="version-empty-key">{shortcutLabel("codexCommit")}</kbd>
      </button>
    </div>
  );
}

/**
 * 本文の左に立つ背骨。Codex の詳細に常にあり、畳んでいるあいだは点と線だけの
 * 56px の列、履歴を開くと 200px に広がって版の行と「この版に戻す」を出す。
 * 本文はどちらのときも隣に残る — 履歴を開いても本文が消えない、が目的。
 *
 * 行は上から下書き → 最新 → … → 最古。行の点は行ごとの grid の左の列で、
 * 点の下の線がその行の高さぶん伸びて次の点へ繋がる。
 */
export default function VersionSpine(props: VersionSpineProps): JSX.Element {
  const emphasis = (row: VersionRow, index: number): "strong" | "faint" => {
    const chosen = props.selectedId === null ? index === 0 : row.version.id === props.selectedId;
    return chosen ? "strong" : "faint";
  };

  /** ↑↓ で隣の版へ。一覧の行と同じ考え方で、背骨の中でだけ受ける。 */
  const onKeyDown = (e: KeyboardEvent): void => {
    const step = ROW_STEP_KEYS[e.key];
    if (step === undefined || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) {
      return;
    }
    const index = props.rows.findIndex((row) => row.version.id === props.selectedId);
    const next = props.rows[index + step];
    if (!next) {
      return;
    }
    e.preventDefault();
    props.onSelect(next.version.id);
    (e.currentTarget as HTMLElement)
      .querySelector<HTMLElement>(`[data-id="${CSS.escape(next.version.id)}"]`)
      ?.focus();
  };

  const secondLine = (row: VersionRow): string => {
    const clock = versionClock(row.version);
    if (row.version.id === props.selectedId && props.same) {
      return `${clock} · ${t().codex.sameShort}`;
    }
    const size =
      row.number === 1
        ? t().codex.sizeOf(row.version.bytes)
        : t().codex.deltaFromLatest(row.number - 1, row.delta);
    return `${clock} · ${size}`;
  };

  return (
    <aside
      class="version-spine"
      classList={{ "version-spine--open": props.open }}
      aria-label={t().codex.history}
    >
      <Show
        when={props.open}
        fallback={
          <button
            type="button"
            class="version-spine-rail"
            title={t().codex.history}
            aria-label={t().codex.history}
            onClick={() => props.onOpen()}
          >
            <Dot kind="draft" />
            <For each={props.rows}>
              {(row, index) => (
                <>
                  <span class="version-rail-line" />
                  <Dot kind={emphasis(row, index())} />
                </>
              )}
            </For>
            <span class="version-spine-rail-label">{t().codex.history}</span>
          </button>
        }
      >
        <div class="version-spine-head">
          <span class="version-spine-title">{t().codex.history}</span>
          <button
            type="button"
            class="icon-button"
            aria-label={t().codex.close}
            title={t().codex.close}
            onClick={() => props.onClose()}
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <Show when={props.rows.length > 0} fallback={<NoVersions onCommit={props.onCommit} />}>
          {/* キーを受けるのは中の行。ここは束ねているだけ */}
          <div class="version-list" role="presentation" onKeyDown={onKeyDown}>
            {/* 下書きは比べる相手ではなく比べる先。行は出すが選べない */}
            <div class="version-row version-row--draft">
              <span class="version-row-rail">
                <Dot kind="draft" />
                <span class="version-rail-line" />
              </span>
              <span class="version-row-text">
                <span class="version-row-line1">{t().codex.draft}</span>
                <span class="version-row-line2">
                  {props.dirty
                    ? t().codex.deltaFromLatest(props.rows.length, props.bytesDelta)
                    : t().codex.sameShort}
                </span>
              </span>
            </div>
            <For each={props.rows}>
              {(row, index) => (
                <button
                  type="button"
                  class="version-row"
                  data-id={row.version.id}
                  aria-current={row.version.id === props.selectedId}
                  onClick={() => props.onSelect(row.version.id)}
                >
                  <span class="version-row-rail">
                    <Dot kind={emphasis(row, index())} />
                    <Show when={index() < props.rows.length - 1}>
                      <span class="version-rail-line" />
                    </Show>
                  </span>
                  <span class="version-row-text">
                    <span class="version-row-line1">{firstLine(row)}</span>
                    <span class="version-row-line2">{secondLine(row)}</span>
                  </span>
                </button>
              )}
            </For>
          </div>

          <div class="version-spine-foot">
            <button
              type="button"
              class="button-secondary"
              disabled={props.readOnly || props.selectedId === null}
              onClick={() => {
                if (props.selectedId !== null) {
                  props.onRestore(props.selectedId);
                }
              }}
            >
              <Icon name="arrow-counter-clockwise" size={14} />
              {t().codex.restore}
            </button>
          </div>
        </Show>
      </Show>
    </aside>
  );
}
