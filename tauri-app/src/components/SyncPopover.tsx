import { createMemo, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import Icon from "./Icon";
import type { IconName } from "./Icon";
import { formatRelativeTime } from "../lib/sync";
import type { SyncState } from "../lib/sync";
import { ROUTES } from "../lib/routes";

interface SyncPopoverProps {
  sync: SyncState;
  onClose: () => void;
}

/** 見た目と文言を決める 4 つの状態。同期の細かい内訳はここでは出さない。 */
type Face = "synced" | "syncing" | "offline" | "failed";

const FACE_ICONS: Record<Face, IconName> = {
  synced: "cloud-check",
  syncing: "cloud-arrow-up",
  offline: "cloud-slash",
  failed: "cloud-warning",
};

const FACE_TITLES: Record<Face, string> = {
  synced: "すべて同期済み",
  syncing: "同期中…",
  offline: "同期していません",
  failed: "同期に失敗しました",
};

export default function SyncPopover(props: SyncPopoverProps): JSX.Element {
  const navigate = useNavigate();

  const face = createMemo<Face>(() => {
    switch (props.sync.status()) {
      case "syncing": {
        return "syncing";
      }
      case "error": {
        return "failed";
      }
      case "needs-setup": {
        return "offline";
      }
      default: {
        return "synced";
      }
    }
  });

  return (
    <div class="popover sync-popover" data-face={face()}>
      <div class="sync-popover-head">
        <Icon name={FACE_ICONS[face()]} size={16} />
        <span class="sync-popover-title">{FACE_TITLES[face()]}</span>
      </div>

      <Show when={face() === "offline"}>
        <p class="sync-popover-body">
          書いたものはこの端末の中だけに残ります。他の端末と揃えたいときだけ設定してください。
        </p>
      </Show>

      {/* 失敗の理由は言い換えず、返ってきた文をそのまま見せる */}
      <Show when={face() === "failed" && props.sync.message()}>
        {(message) => <pre class="sync-popover-error">{message()}</pre>}
      </Show>

      <Show when={props.sync.lastSyncedAt()}>
        {(at) => <p class="sync-popover-detail">最終同期 {formatRelativeTime(at(), new Date())}</p>}
      </Show>

      <Show when={face() !== "offline"}>
        <label class="sync-popover-toggle">
          <span>保存時に自動同期</span>
          <input
            type="checkbox"
            checked={props.sync.autoSync()}
            onChange={(e) => void props.sync.setAutoSync(e.currentTarget.checked)}
          />
          <span class="switch" aria-hidden="true" />
        </label>
      </Show>

      <div class="sync-popover-actions">
        <Show
          when={face() === "offline"}
          fallback={
            <button
              type="button"
              class={face() === "failed" ? "button-secondary" : "link-button"}
              onClick={() => {
                props.onClose();
                void props.sync.syncNow();
              }}
            >
              {face() === "failed" ? "再試行" : "今すぐ同期"}
            </button>
          }
        >
          <button
            type="button"
            class="link-button"
            onClick={() => {
              props.onClose();
              navigate(ROUTES.SETTINGS);
            }}
          >
            設定を開く
          </button>
        </Show>
      </div>
    </div>
  );
}
