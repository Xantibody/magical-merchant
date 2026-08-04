import { createSignal, createResource, createMemo, For, Show, onMount } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import type { IconName } from "./Icon";
import { typedInvoke } from "../lib/commands";
import type { SearchHit } from "../lib/commands";

interface PaletteCommand {
  id: string;
  label: string;
  icon: IconName;
  shortcut?: string;
  run: () => void;
}

interface CommandPaletteProps {
  commands: PaletteCommand[];
  onSelectHit: (hit: SearchHit) => void;
  onClose: () => void;
}

interface Row {
  key: string;
  run: () => void;
}

function searchHits(query: string): Promise<SearchHit[]> {
  if (!query.trim()) {
    return Promise.resolve([]);
  }
  return typedInvoke("search_all", { query });
}

export default function CommandPalette(props: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [cursor, setCursor] = createSignal(0);
  const [hits] = createResource(query, searchHits);

  let inputRef: HTMLInputElement | undefined;
  onMount(() => inputRef?.focus());

  const matchingCommands = createMemo(() => {
    const needle = query().trim().toLowerCase();
    if (!needle) {
      return props.commands;
    }
    return props.commands.filter((c) => c.label.toLowerCase().includes(needle));
  });

  const rows = createMemo<Row[]>(() => [
    ...matchingCommands().map((command) => ({ key: `cmd:${command.id}`, run: command.run })),
    ...(hits() ?? []).map((hit, i) => ({
      key: `hit:${i}`,
      run: () => props.onSelectHit(hit),
    })),
  ]);

  const clampedCursor = createMemo(() => Math.min(cursor(), Math.max(rows().length - 1, 0)));

  const handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor(Math.min(clampedCursor() + 1, rows().length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor(Math.max(clampedCursor() - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      rows()[clampedCursor()]?.run();
    }
  };

  const commandOffset = (): number => matchingCommands().length;

  return (
    <div
      class="palette-overlay"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          props.onClose();
        }
      }}
    >
      <div class="palette" role="dialog" aria-modal="true" aria-label="検索・コマンド">
        <div class="palette-input-row">
          <Icon name="magnifying-glass" size={17} />
          <input
            ref={inputRef}
            type="text"
            class="palette-input"
            placeholder="検索・コマンド…"
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setCursor(0);
            }}
            onKeyDown={handleKeyDown}
          />
          <span class="key-badge">esc</span>
        </div>

        <div class="palette-results">
          <Show when={matchingCommands().length}>
            <div class="palette-section">コマンド</div>
            <For each={matchingCommands()}>
              {(command, i) => (
                <button
                  type="button"
                  class="palette-row"
                  classList={{ "palette-row--active": clampedCursor() === i() }}
                  onClick={command.run}
                >
                  <Icon name={command.icon} size={16} />
                  <span class="palette-row-label">{command.label}</span>
                  <Show when={command.shortcut}>
                    {(shortcut) => <span class="palette-row-meta">{shortcut()}</span>}
                  </Show>
                </button>
              )}
            </For>
          </Show>

          <Show when={hits()?.length}>
            <div class="palette-section">ノート・エントリ</div>
            <For each={hits()}>
              {(hit, i) => (
                <button
                  type="button"
                  class="palette-row"
                  classList={{ "palette-row--active": clampedCursor() === commandOffset() + i() }}
                  onClick={() => props.onSelectHit(hit)}
                >
                  <Icon name={hit.kind === "note" ? "file-text" : "lightning"} size={16} />
                  <span class="palette-row-label">{hit.title || hit.snippet}</span>
                  <span class="palette-row-meta">{hit.date.slice(5).replace("-", "/")}</span>
                </button>
              )}
            </For>
          </Show>

          <Show when={query().trim() && !hits.loading && !hits()?.length}>
            <p class="palette-empty">一致するものがありません</p>
          </Show>
        </div>
      </div>
    </div>
  );
}
