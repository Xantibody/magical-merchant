import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import { typedInvoke } from "../lib/commands";
import { renderDiffBlock } from "../lib/diff-block";
import { t } from "../lib/i18n";
import { formatRecordedAt } from "../lib/note-meta";
import { versionMessage, withDeltas } from "../lib/versions";
import "../styles/versions.css";

interface VersionHistoryProps {
  filename: string;
  /** 最新の版から下書きが変わっているか。立っていれば先頭に「下書き」の行を出す。 */
  dirty: boolean;
  /** 読み取り専用のノートには戻せない。書けないノートを書き換えることになる。 */
  readOnly: boolean;
  onRestore: (id: string) => void;
  onClose: () => void;
}

/**
 * Codex の版を並べ、選んだ版といまの下書きの差分を出す。
 *
 * 本文の場所に置き換わる。版どうしの比較は付けない — 知りたいのは
 * 「あの版からどう育ったか」で、それは常に下書きとの差。DOM は版の行と
 * 差分 1 つだけで、文書を 2 枚並べることはしない。
 */
export default function VersionHistory(props: VersionHistoryProps): JSX.Element {
  const [selectedId, setSelectedId] = createSignal<string | null>(null);

  const [versions] = createResource(
    () => props.filename,
    (filename) => typedInvoke("list_note_versions", { filename }),
  );

  const [diff] = createResource(
    () => {
      const id = selectedId();
      return id === null ? undefined : { filename: props.filename, from: id };
    },
    (args) => typedInvoke("diff_note_versions", args),
  );

  const rows = (): ReturnType<typeof withDeltas> => withDeltas(versions() ?? []);

  onMount(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        props.onClose();
      }
    };
    globalThis.addEventListener("keydown", onKeyDown);
    onCleanup(() => globalThis.removeEventListener("keydown", onKeyDown));
  });

  return (
    <div class="version-history" role="region" aria-label={t().codex.history}>
      <div class="version-history-head">
        <span class="version-history-title">{t().codex.history}</span>
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

      <div class="version-list">
        {/* 下書きは比べる相手ではなく比べる先。行は出すが選べない */}
        <Show when={props.dirty}>
          <div class="version-row version-row--draft">
            <span class="version-time" />
            <span class="version-message">{t().codex.draft}</span>
            <span class="version-delta" />
          </div>
        </Show>
        <Show when={!versions.loading && rows().length === 0}>
          <p class="version-empty">{t().codex.noVersions}</p>
        </Show>
        <For each={rows()}>
          {(row) => (
            <button
              type="button"
              class="version-row"
              aria-current={selectedId() === row.version.id}
              onClick={() => setSelectedId(row.version.id)}
            >
              <span class="version-time">{formatRecordedAt(row.version.time)}</span>
              <span class="version-message">
                {versionMessage(row.version, t().codex.beforeRestore)}
              </span>
              <span class="version-delta">{t().codex.sizeDelta(row.delta)}</span>
            </button>
          )}
        </For>
      </div>

      <Show when={selectedId()}>
        {(id) => (
          <div class="version-diff">
            <Show when={!diff.loading}>
              <Show when={diff()} fallback={<p class="version-empty">{t().codex.same}</p>}>
                {/* ```diff フェンスと同じ描き方・同じ枠。色を足さない */}
                {(text) => <div class="markdown-preview" innerHTML={renderDiffBlock(text())} />}
              </Show>
            </Show>
            <div class="version-diff-actions">
              <button
                type="button"
                class="button-secondary"
                disabled={props.readOnly}
                onClick={() => props.onRestore(id())}
              >
                <Icon name="arrow-counter-clockwise" size={14} />
                {t().codex.restore}
              </button>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
