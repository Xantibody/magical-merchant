import { describe, it, expect, afterEach } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, fireEvent, cleanup, waitFor } from "@solidjs/testing-library";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import SyncPopover from "./SyncPopover";
import type { SyncState, SyncStatus } from "../lib/sync";

/** A sync state frozen at one status. The popover only reads; nothing here needs Tauri */
function frozen(status: SyncStatus): SyncState {
  const [value] = createSignal(status);
  const [off] = createSignal(false);
  const [none] = createSignal<Date | null>(null);
  const [empty] = createSignal("");
  const [zero] = createSignal(0);
  return {
    status: value,
    message: empty,
    lastSyncedAt: none,
    autoSync: off,
    setAutoSync: async () => {},
    syncNow: async () => {},
    syncOnStart: off,
    setSyncOnStart: async () => {},
    resume: () => {},
    alertVersion: zero,
  };
}

function mount(status: SyncStatus): { history: ReturnType<typeof createMemoryHistory> } {
  const history = createMemoryHistory();
  render(() => (
    <MemoryRouter history={history}>
      <Route path="*" component={() => <SyncPopover sync={frozen(status)} onClose={() => {}} />} />
    </MemoryRouter>
  ));
  return { history };
}

describe("SyncPopover", () => {
  afterEach(() => {
    cleanup();
  });

  // "Open Settings" is said about the sync page. Landing on the general page left the user
  // one tap short of it, and on a phone looking at the list of pages
  it("sends the unset device to the sync page of Settings", async () => {
    const { history } = mount("needs-setup");

    fireEvent.click(screen.getByRole("button", { name: "設定を開く" }));

    await waitFor(() => expect(history.get()).toBe("/settings?page=sync"));
  });

  // A lost login is not "local only". The device was set up for sync and it has stopped,
  // so the popover says so and the one action is to sign in again
  it("says the login is gone and offers to sign in again", async () => {
    const { history } = mount("signed-out");

    expect(screen.getByText("ログインが切れています")).toBeDefined();
    expect(screen.queryByText(/この端末の中だけに残ります/u)).toBeNull();
    // The settings are still the user's; the switches stay in reach
    expect(screen.getByLabelText("保存時に自動同期")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "ログインする" }));

    await waitFor(() => expect(history.get()).toBe("/settings?page=sync"));
  });
});
