import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import Icon from "./Icon";
import { formatRelativeTime } from "../lib/sync";
import type { SyncState } from "../lib/sync";
import { ROUTES } from "../lib/routes";

interface SyncPopoverProps {
  sync: SyncState;
  onClose: () => void;
}

export default function SyncPopover(props: SyncPopoverProps): JSX.Element {
  const navigate = useNavigate();

  const isProblem = (): boolean => {
    const status = props.sync.status();
    return status === "error" || status === "needs-setup";
  };

  const headline = (): string => {
    switch (props.sync.status()) {
      case "syncing": {
        return "同期中…";
      }
      case "error":
      case "needs-setup": {
        return props.sync.message();
      }
      default: {
        return props.sync.message() || "すべて同期済み";
      }
    }
  };

  return (
    <div class="popover sync-popover" classList={{ "sync-popover--problem": isProblem() }}>
      <div class="sync-popover-status">
        <Icon name={isProblem() ? "cloud-warning" : "check-circle"} size={16} />
        <span>{headline()}</span>
      </div>

      <Show when={props.sync.lastSyncedAt()}>
        {(at) => (
          <div class="sync-popover-detail">最終同期: {formatRelativeTime(at(), new Date())}</div>
        )}
      </Show>

      <label class="sync-popover-toggle">
        保存時に自動同期
        <input
          type="checkbox"
          checked={props.sync.autoSync()}
          onChange={(e) => void props.sync.setAutoSync(e.currentTarget.checked)}
        />
        <span class="switch" aria-hidden="true" />
      </label>

      <Show
        when={props.sync.status() === "needs-setup"}
        fallback={
          <button
            type="button"
            class="link-button"
            onClick={() => {
              props.onClose();
              void props.sync.syncNow();
            }}
          >
            今すぐ同期
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
  );
}
