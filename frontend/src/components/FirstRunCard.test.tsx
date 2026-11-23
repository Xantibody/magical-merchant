import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@solidjs/testing-library";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import FirstRunCard from "./FirstRunCard";

describe("FirstRunCard", () => {
  beforeEach(() => {
    localStorage.removeItem("first-run-dismissed");
  });

  afterEach(() => {
    cleanup();
    clearMocks();
    localStorage.removeItem("first-run-dismissed");
  });

  // get_sync_config refuses a broken file with { kind, message }. The card showed
  // `[object Object]` in place of the words that say which file could not be read
  it("shows the words of a broken config rather than an object", async () => {
    // The first command the card calls is get_sync_config, and that refusal ends the attempt
    const corrupt = Object.assign(new Error("Could not read sync-config.json: bad"), {
      kind: "configCorrupt",
    });
    mockIPC(() => {
      throw corrupt;
    });
    render(() => <FirstRunCard when onConnected={() => {}} />);

    fireEvent.input(screen.getByPlaceholderText("https://....workers.dev"), {
      target: { value: "https://example.workers.dev" },
    });
    fireEvent.click(screen.getByRole("button", { name: "接続" }));

    await waitFor(() =>
      expect(screen.getByText("Could not read sync-config.json: bad")).toBeDefined(),
    );
    expect(screen.queryByText("[object Object]")).toBeNull();
  });
});
