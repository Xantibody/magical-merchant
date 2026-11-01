import { describe, it, expect, afterEach, vi } from "vitest";
import type { JSX } from "solid-js";
import { render, screen, fireEvent, cleanup } from "@solidjs/testing-library";
import StatusDot, { StatusDetails, dotLabel, dotTone } from "./StatusDot";
import { ShellProvider, useShell } from "../lib/shell";
import type { NoteState, Shell } from "../lib/shell";

function note(overrides: Partial<NoteState> = {}): NoteState {
  return {
    map: false,
    examples: false,
    canCommit: false,
    canRevert: false,
    commit: () => {},
    revert: () => {},
    openSettings: () => {},
    openHistory: () => {},
    ...overrides,
  };
}

/** Mounts `what` inside a shell and hands the shell back, for a test to set state on. */
function inShell(what: () => JSX.Element): Shell {
  let captured: Shell | undefined;
  const Probe = (): JSX.Element => {
    captured = useShell();
    return what();
  };
  render(() => (
    <ShellProvider>
      <Probe />
    </ShellProvider>
  ));
  if (!captured) {
    throw new Error("the shell did not mount");
  }
  return captured;
}

const LINKS = {
  onScrawl: () => {},
  onSearch: () => {},
  onSettings: () => {},
  onKeys: () => {},
};

describe("dotTone", () => {
  it("is green when everything landed", () => {
    expect(dotTone("idle", "idle")).toBe("ok");
    expect(dotTone("savedAt", "success")).toBe("ok");
  });

  it("is grey while either a save or a sync is under way", () => {
    expect(dotTone("saving", "success")).toBe("busy");
    expect(dotTone("savedAt", "syncing")).toBe("busy");
  });

  // Red is the only tone that asks for anything, so it wins over work in flight
  it("is red on a failed save or sync, even with the other still running", () => {
    expect(dotTone("failed", "syncing")).toBe("failed");
    expect(dotTone("saving", "error")).toBe("failed");
  });

  // Set up, then stopped: the user asked for sync and is not getting it
  it("is red when the login is gone", () => {
    expect(dotTone("idle", "signed-out")).toBe("failed");
  });

  // A device that never asked for sync has nothing wrong, and a dot red forever says nothing
  it("stays green on a device never set up", () => {
    expect(dotTone("savedAt", "needs-setup")).toBe("ok");
  });
});

describe("dotLabel", () => {
  it("does not claim a sync on a device that has none", () => {
    expect(dotLabel("ok", "needs-setup")).toBe("保存しました");
    expect(dotLabel("ok", "success")).toBe("保存・同期済み");
  });
});

describe("StatusDot", () => {
  afterEach(() => {
    cleanup();
  });

  it("wears the tone of the save", () => {
    const shell = inShell(() => <StatusDot sync="success" onOpen={() => {}} {...LINKS} />);
    const dot = screen.getByRole("button", { name: /保存と同期/u });

    expect(dot.dataset.tone).toBe("ok");

    shell.setSaveState({ status: "saving", at: "" });
    expect(dot.dataset.tone).toBe("busy");

    shell.setSaveState({ status: "failed", at: "" });
    expect(dot.dataset.tone).toBe("failed");
  });

  it("hands the pressed button over so the popover can fold on it", () => {
    const onOpen = vi.fn<(trigger: HTMLElement) => void>();
    inShell(() => <StatusDot sync="success" onOpen={onOpen} {...LINKS} />);
    const dot = screen.getByRole("button", { name: /保存と同期/u });

    fireEvent.click(dot);

    expect(onOpen).toHaveBeenCalledWith(dot);
  });

  it("offers settings and the key list beside the dot", () => {
    const onScrawl = vi.fn<() => void>();
    const onSearch = vi.fn<() => void>();
    const onSettings = vi.fn<() => void>();
    const onKeys = vi.fn<() => void>();
    inShell(() => (
      <StatusDot
        sync="success"
        onOpen={() => {}}
        onScrawl={onScrawl}
        onSearch={onSearch}
        onSettings={onSettings}
        onKeys={onKeys}
      />
    ));

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "キー" }));

    expect(onSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Scrawl" }));
    fireEvent.click(screen.getByRole("button", { name: "検索" }));
    expect(onScrawl).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onKeys).toHaveBeenCalledTimes(1);
  });
});

describe("StatusDetails", () => {
  afterEach(() => {
    cleanup();
  });

  it("says when the save landed", () => {
    const shell = inShell(() => <StatusDetails onClose={() => {}} />);

    shell.setSaveState({ status: "savedAt", at: "22:18" });

    expect(screen.getByText("22:18 に保存")).toBeDefined();
  });

  it("says a failed save outright", () => {
    const shell = inShell(() => <StatusDetails onClose={() => {}} />);

    shell.setSaveState({ status: "failed", at: "22:18" });

    expect(screen.getByText("保存できませんでした")).toBeDefined();
    expect(screen.queryByText("22:18 に保存")).toBeNull();
  });

  // The two actions are worth a place only while they would do something
  it("offers no action on a note with nothing to do", () => {
    const shell = inShell(() => <StatusDetails onClose={() => {}} />);

    shell.setNoteState(note());

    expect(screen.queryByRole("button", { name: "編集前に戻す" })).toBeNull();
    expect(screen.queryByRole("button", { name: "版を刻む" })).toBeNull();
  });

  it("folds, then reverts", () => {
    const revert = vi.fn<() => void>();
    const onClose = vi.fn<() => void>();
    const shell = inShell(() => <StatusDetails onClose={onClose} />);

    shell.setNoteState(note({ canRevert: true, revert }));
    fireEvent.click(screen.getByRole("button", { name: "編集前に戻す" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(revert).toHaveBeenCalledTimes(1);
  });

  // The writing screen has no meta line, and this is where it can still read how far it moved
  it("sets the version beside the commit that would move it", () => {
    const commit = vi.fn<() => void>();
    const shell = inShell(() => <StatusDetails onClose={() => {}} />);

    shell.setNoteState(note({ version: "版 4 から +312 B", canCommit: true, commit }));
    fireEvent.click(screen.getByRole("button", { name: "版を刻む" }));

    expect(screen.getByText("版 4 から +312 B")).toBeDefined();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("names the states that are on, each leading to its switch", () => {
    const openSettings = vi.fn<() => void>();
    const openHistory = vi.fn<() => void>();
    const shell = inShell(() => <StatusDetails onClose={() => {}} />);

    shell.setNoteState(
      note({ map: true, examples: true, comparing: "版 2 と比較中", openSettings, openHistory }),
    );
    fireEvent.click(screen.getByRole("button", { name: "版 2 と比較中" }));
    fireEvent.click(screen.getByRole("button", { name: "マップ" }));
    fireEvent.click(screen.getByRole("button", { name: "記入例" }));

    expect(openHistory).toHaveBeenCalledTimes(1);
    expect(openSettings).toHaveBeenCalledTimes(2);
  });
});
