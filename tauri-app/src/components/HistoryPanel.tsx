import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import { t } from "../lib/i18n";
import { isBeforeRestore, versionClock, versionDay, versionMessage } from "../lib/versions";
import type { VersionRow } from "../lib/versions";
import "../styles/history.css";

interface HistoryPanelProps {
  /** 版。新しい順。 */
  rows: VersionRow[];
  /** 「3 版 · 9 か月」。数えるのは面の側。 */
  summary: string;
  /** 最新の版から下書きが動いているか。 */
  dirty: boolean;
  /** 下書きと最新の版のバイト差。 */
  bytesDelta: number;
  /**
   * 開いているか。閉じているあいだも DOM に残り、右へ 24px ずれて透ける —
   * 畳むところまで見えるのは、開いた場所に戻ることが分かるため。
   */
  open: boolean;
  /**
   * 携帯の専用画面として出しているか。パネルではなく面になり、戻すは
   * 本文の下の比較バーが持つ。
   */
  screen?: boolean;
  /** 履歴で選んでいる版。 */
  selectedId: string | null;
  /** 読み取り専用のノートには戻せない。 */
  readOnly: boolean;
  /** 刻んだばかりの版。その行だけが跳ねて入る。 */
  freshId?: string | null;
  onClose: () => void;
  onSelect: (id: string) => void;
  onRestore: (id: string) => void;
  onCommit: () => void;
}

/** ↑↓ で版の行を送る向き。 */
const ROW_STEP_KEYS: Readonly<Record<string, 1 | -1>> = { ArrowUp: -1, ArrowDown: 1 };

/** 点の種類。下書きは中空、強調(選択中か最新)は大きい塗り、他は小さい薄い点。 */
function Dot(props: { kind: "draft" | "strong" | "faint" }): JSX.Element {
  return <span class="history-dot" data-kind={props.kind} />;
}

/** 行の右端の日時。「08/12 22:18」 */
function stamp(row: VersionRow): string {
  return `${versionDay(row.version)} ${versionClock(row.version)}`;
}

/**
 * 行の 2 行目。いちばん古い版は「最初の版 · 2.1 KB」、他は 1 つ古い版との
 * バイト差。行数は出さない — 版ごとに本文 2 本を読む値段に対して、開くたびに
 * 払うだけの中身が無い(比較中の行数は比較バーとメタ行が言う)。
 */
function delta(row: VersionRow): string {
  return [
    versionMessage(row.version, t().codex.beforeRestore),
    row.number === 1
      ? t().codex.firstVersion(row.version.bytes)
      : t().codex.deltaFromLatest(row.number - 1, row.delta),
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * 版ゼロの Codex で履歴を開いたとき。空の一覧を見せる代わりに、次の一手
 * (刻む)をここに置く。
 */
function NoVersions(props: { onCommit: () => void }): JSX.Element {
  return (
    <div class="history-empty">
      <p class="history-empty-hint">{t().codex.noVersionsHint}</p>
      <button type="button" class="button-secondary" onClick={() => props.onCommit()}>
        <Icon name="book-bookmark" size={14} />
        {t().codex.commit}
      </button>
    </div>
  );
}

/**
 * 版の一覧。広い窓では本文の右に立つ 320px のパネル、携帯では本文と
 * 入れ替わる専用の画面。どちらも中身は同じ 3 段 — 見出し・下書きと版の行・
 * 足元の案内。
 *
 * ホバーでは開かない。履歴ボタン・Esc・× だけが開け閉めする — 本文を書いて
 * いる手の横で、通りすがりに 320px が現れてはいけない。
 *
 * 行は上から下書き → 最新 → … → 最古。点の下の線がその行の高さぶん伸びて
 * 次の点へ繋がる。
 */
export default function HistoryPanel(props: HistoryPanelProps): JSX.Element {
  const emphasis = (row: VersionRow, index: number): "strong" | "faint" => {
    const chosen = props.selectedId === null ? index === 0 : row.version.id === props.selectedId;
    return chosen ? "strong" : "faint";
  };

  /** ↑↓ で隣の版へ。一覧の行と同じ考え方で、この中でだけ受ける。 */
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

  return (
    <aside
      class="history-panel"
      classList={{
        "history-panel--open": props.open,
        "history-panel--screen": props.screen,
      }}
      aria-label={t().codex.history}
      aria-hidden={!props.open}
    >
      <div class="history-head">
        {/* 携帯では面ごと入れ替わるので、戻る先は本文。広い窓では × で畳む */}
        <Show when={props.screen} fallback={<span class="history-title">{t().codex.history}</span>}>
          <button
            type="button"
            class="icon-button history-back"
            aria-label={t().codex.backToBody}
            onClick={() => props.onClose()}
          >
            <Icon name="arrow-left" size={18} />
          </button>
          <span class="history-title">{t().codex.history}</span>
        </Show>
        <span class="history-summary">{props.summary}</span>
        {/* 開け閉ての決まりは、開いているものの中に書く。携帯は面ごと
            入れ替わるので、閉じ方ではなく押し方だけを言う */}
        <Show
          when={props.screen}
          fallback={
            <button
              type="button"
              class="icon-button history-close"
              aria-label={t().codex.close}
              title={t().codex.close}
              onClick={() => props.onClose()}
            >
              <Icon name="x" size={14} />
            </button>
          }
        >
          <span class="history-hint">{t().codex.historyHint}</span>
        </Show>
      </div>

      <Show when={props.rows.length > 0} fallback={<NoVersions onCommit={props.onCommit} />}>
        {/* キーを受けるのは中の行。ここは束ねているだけ */}
        <div class="history-list" role="presentation" onKeyDown={onKeyDown}>
          {/* 下書きは比べる相手ではなく比べる先。行は出すが選べない */}
          <div class="history-row history-row--draft">
            <span class="history-row-rail">
              <Dot kind="draft" />
              <span class="history-rail-line" data-dashed="" />
            </span>
            <span class="history-row-text">
              <span class="history-row-line1">
                {t().codex.draft}
                <span class="history-row-delta" data-moved={props.dirty ? "" : undefined}>
                  {props.dirty ? t().codex.sizeDelta(props.bytesDelta) : t().codex.sameShort}
                </span>
              </span>
              <span class="history-row-line2">
                {props.dirty
                  ? t().codex.nextVersion(props.rows.length + 1)
                  : t().codex.sameAsVersion(props.rows.length)}
              </span>
            </span>
          </div>

          <For each={props.rows}>
            {(row, index) => (
              <>
                <button
                  type="button"
                  class="history-row"
                  classList={{ "history-row--fresh": row.version.id === props.freshId }}
                  data-id={row.version.id}
                  aria-current={row.version.id === props.selectedId}
                  onClick={() => props.onSelect(row.version.id)}
                >
                  <span class="history-row-rail">
                    <Dot kind={emphasis(row, index())} />
                    <Show when={index() < props.rows.length - 1}>
                      <span class="history-rail-line" />
                    </Show>
                  </span>
                  <span class="history-row-text">
                    <span class="history-row-line1">
                      {t().codex.versionN(row.number)}
                      <span class="history-row-stamp">
                        {isBeforeRestore(row.version) ? versionClock(row.version) : stamp(row)}
                      </span>
                    </span>
                    <span class="history-row-line2">{delta(row)}</span>
                  </span>
                </button>
                {/* 戻すのは選んだ 1 つに対する操作。行の下に置いて、どの版に
                    戻るのかを取り違えられないようにする。携帯では比較バーが持つ */}
                <Show when={!props.screen && row.version.id === props.selectedId}>
                  <div class="history-restore">
                    <button
                      type="button"
                      class="button-secondary"
                      disabled={props.readOnly}
                      onClick={() => props.onRestore(row.version.id)}
                    >
                      <Icon name="arrow-counter-clockwise" size={13} />
                      {t().codex.restoreN(row.number)}
                    </button>
                  </div>
                </Show>
              </>
            )}
          </For>
        </div>
      </Show>

      <Show when={!props.screen}>
        <div class="history-foot">{t().codex.historyFoot}</div>
      </Show>
    </aside>
  );
}
