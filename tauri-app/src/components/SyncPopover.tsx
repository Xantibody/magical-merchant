import { createMemo, Match, Show, Switch } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import Icon from "./Icon";
import type { IconName } from "./Icon";
import { t } from "../lib/i18n";
import { formatRelativeTime } from "../lib/sync";
import type { SyncState } from "../lib/sync";
import { settingsPage } from "../lib/routes";

interface SyncPopoverProps {
  sync: SyncState;
  onClose: () => void;
}

/**
 * The five states that decide the look and wording. The detailed sync breakdown stays out.
 * `offline` is a device never set up (quiet, local only); `signed-out` is one that was set
 * up and lost its login, which is a stop the user asked not to have.
 */
type Face = "synced" | "syncing" | "offline" | "signed-out" | "failed";

const FACE_ICONS: Record<Face, IconName> = {
  synced: "cloud-check",
  syncing: "cloud-arrow-up",
  offline: "cloud-slash",
  "signed-out": "cloud-warning",
  failed: "cloud-warning",
};

function faceTitle(face: Face): string {
  const labels = t().sync;
  return {
    synced: labels.synced,
    syncing: labels.syncing,
    offline: labels.notSyncing,
    "signed-out": labels.signedOut,
    failed: labels.failed,
  }[face];
}

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
      case "signed-out": {
        return "signed-out";
      }
      default: {
        return "synced";
      }
    }
  });

  const openSyncSettings = (): void => {
    props.onClose();
    navigate(settingsPage("sync"));
  };

  return (
    <div class="popover sync-popover" data-face={face()}>
      <div class="sync-popover-head">
        <Icon name={FACE_ICONS[face()]} size={16} />
        <span class="sync-popover-title">{faceTitle(face())}</span>
      </div>

      <Show when={face() === "offline"}>
        <p class="sync-popover-body">{t().sync.localOnly}</p>
      </Show>
      <Show when={face() === "signed-out"}>
        <p class="sync-popover-body">{t().sync.signedOutBody}</p>
      </Show>

      {/* The reason for the failure is not reworded: the returned text is shown as it is */}
      <Show when={face() === "failed" && props.sync.message()}>
        {(message) => <pre class="sync-popover-error">{message()}</pre>}
      </Show>

      <Show when={props.sync.lastSyncedAt()}>
        {(at) => (
          <p class="sync-popover-detail">
            {t().sync.lastSync(formatRelativeTime(at(), new Date()))}
          </p>
        )}
      </Show>

      <Show when={face() !== "offline"}>
        <label class="sync-popover-toggle">
          <span>{t().sync.autoSync}</span>
          <input
            type="checkbox"
            checked={props.sync.autoSync()}
            onChange={(e) => {
              void props.sync.setAutoSync(e.currentTarget.checked);
            }}
          />
          <span class="switch" aria-hidden="true" />
        </label>
        <label class="sync-popover-toggle">
          <span>{t().sync.syncOnStart}</span>
          <input
            type="checkbox"
            checked={props.sync.syncOnStart()}
            onChange={(e) => {
              void props.sync.setSyncOnStart(e.currentTarget.checked);
            }}
          />
          <span class="switch" aria-hidden="true" />
        </label>
      </Show>

      <div class="sync-popover-actions">
        <Switch
          fallback={
            <button
              type="button"
              class={face() === "failed" ? "button-secondary" : "link-button"}
              onClick={() => {
                props.onClose();
                void props.sync.syncNow();
              }}
            >
              {face() === "failed" ? t().sync.retry : t().sync.now}
            </button>
          }
        >
          <Match when={face() === "offline"}>
            <button type="button" class="link-button" onClick={openSyncSettings}>
              {t().sync.openSettings}
            </button>
          </Match>
          <Match when={face() === "signed-out"}>
            <button type="button" class="button-secondary" onClick={openSyncSettings}>
              {t().sync.signIn}
            </button>
          </Match>
        </Switch>
      </div>
    </div>
  );
}
