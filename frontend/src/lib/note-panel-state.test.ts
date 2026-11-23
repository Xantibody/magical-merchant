import { describe, it, expect } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createNotePanel } from "./note-panel-state";

interface Start {
  twoPane?: boolean;
  writing?: boolean;
  historyOpen?: boolean;
  pinned?: boolean;
}

/**
 * The deps are plain signals, so a test moves the width, the writing screen or compare mode
 * from outside the root and the panel's effect sees it. Calls are recorded, not mocked.
 */
function setup(start: Start = {}) {
  const [twoPane, setTwoPane] = createSignal(start.twoPane ?? true);
  const [writing, setWriting] = createSignal(start.writing ?? false);
  const [historyOpen, setHistoryOpen] = createSignal(start.historyOpen ?? false);
  const [pinned, setPinnedSignal] = createSignal(start.pinned ?? false);
  const pinnedCalls: boolean[] = [];
  let leaveHistoryCalls = 0;

  return createRoot((dispose) => {
    const panel = createNotePanel({
      twoPane,
      writing,
      historyOpen,
      pinned,
      setPinned: (value) => {
        pinnedCalls.push(value);
        setPinnedSignal(value);
      },
      leaveHistory: () => {
        leaveHistoryCalls += 1;
        setHistoryOpen(false);
      },
    });
    return {
      panel,
      pinned,
      setTwoPane,
      setWriting,
      setHistoryOpen,
      pinnedCalls,
      leaveHistoryCalls: () => leaveHistoryCalls,
      dispose,
    };
  });
}

describe("createNotePanel", () => {
  describe("show", () => {
    it("docks the panel in a wide window and leaves the sheet down", () => {
      const s = setup({ twoPane: true });
      s.panel.show();

      expect(s.pinnedCalls).toStrictEqual([true]);
      expect(s.panel.open()).toBe(true);
      s.panel.setScreen(true);
      expect(s.panel.screenShown()).toBe(false);
      s.dispose();
    });

    it("raises the sheet on a phone without touching the pin", () => {
      const s = setup({ twoPane: false });
      s.panel.show();

      expect(s.panel.screenShown()).toBe(true);
      expect(s.pinnedCalls).toStrictEqual([]);
      expect(s.panel.open()).toBe(false);
      s.dispose();
    });
  });

  describe("close", () => {
    it("leaves the history and drops both the pin and the sheet", () => {
      const s = setup({ twoPane: false, pinned: true, historyOpen: true });
      s.panel.setScreen(true);
      s.panel.close();

      expect(s.leaveHistoryCalls()).toBe(1);
      expect(s.pinnedCalls).toStrictEqual([false]);
      expect(s.panel.screenShown()).toBe(false);
      expect(s.panel.tab()).toBe("note");
      s.dispose();
    });

    // The sheet signal is the note's own, so a window that widens later starts folded
    it("drops the sheet even in a wide window, where it does not show", () => {
      const s = setup({ twoPane: true, pinned: true });
      s.panel.setScreen(true);
      s.panel.close();
      s.setTwoPane(false);

      expect(s.panel.screenShown()).toBe(false);
      expect(s.panel.open()).toBe(false);
      s.dispose();
    });
  });

  describe("toggle", () => {
    it("does nothing while the writing screen is up", () => {
      const s = setup({ twoPane: true });
      s.setWriting(true);
      const leavesBefore = s.leaveHistoryCalls();
      const pinsBefore = s.pinnedCalls.length;
      s.panel.toggle();

      expect(s.pinnedCalls).toHaveLength(pinsBefore);
      expect(s.leaveHistoryCalls()).toBe(leavesBefore);
      expect(s.panel.open()).toBe(false);
      s.dispose();
    });

    it("does nothing on a phone while writing either", () => {
      const s = setup({ twoPane: false, writing: true });
      s.panel.toggle();

      expect(s.panel.screenShown()).toBe(false);
      s.dispose();
    });

    it("flips the sheet on a phone and never the pin", () => {
      const s = setup({ twoPane: false });
      s.panel.toggle();
      expect(s.panel.screenShown()).toBe(true);

      s.panel.toggle();
      expect(s.panel.screenShown()).toBe(false);
      expect(s.pinnedCalls).toStrictEqual([]);
      expect(s.leaveHistoryCalls()).toBe(0);
      s.dispose();
    });

    it("pins the panel in a wide window, then folds it through close", () => {
      const s = setup({ twoPane: true, historyOpen: true });
      s.panel.toggle();
      expect(s.pinnedCalls).toStrictEqual([true]);
      expect(s.panel.open()).toBe(true);
      expect(s.leaveHistoryCalls()).toBe(0);

      s.panel.toggle();
      expect(s.pinnedCalls).toStrictEqual([true, false]);
      expect(s.panel.open()).toBe(false);
      expect(s.leaveHistoryCalls()).toBe(1);
      s.dispose();
    });
  });

  describe("the writing screen", () => {
    it("closes the panel when it comes up", () => {
      const s = setup({ twoPane: true, pinned: true, historyOpen: true });
      expect(s.leaveHistoryCalls()).toBe(0);
      s.setWriting(true);

      expect(s.leaveHistoryCalls()).toBe(1);
      expect(s.pinnedCalls).toStrictEqual([false]);
      expect(s.panel.open()).toBe(false);
      s.dispose();
    });

    it("takes the phone's sheet down when it comes up", () => {
      const s = setup({ twoPane: false });
      s.panel.show();
      s.setWriting(true);

      expect(s.panel.screenShown()).toBe(false);
      s.dispose();
    });

    it("does not close anything when it goes away", () => {
      const s = setup({ twoPane: true, writing: true });
      const leavesBefore = s.leaveHistoryCalls();
      s.setWriting(false);

      expect(s.leaveHistoryCalls()).toBe(leavesBefore);
      s.dispose();
    });

    // `on` without `defer` runs once at creation, so a panel made over the writing screen
    // starts by closing
    it("closes once at creation when the writing screen is already up", () => {
      const s = setup({ twoPane: true, writing: true, pinned: true });

      expect(s.leaveHistoryCalls()).toBe(1);
      expect(s.pinnedCalls).toStrictEqual([false]);
      s.dispose();
    });
  });

  describe("tab", () => {
    it("follows historyOpen", () => {
      const s = setup();
      expect(s.panel.tab()).toBe("note");

      s.setHistoryOpen(true);
      expect(s.panel.tab()).toBe("history");

      s.setHistoryOpen(false);
      expect(s.panel.tab()).toBe("note");
      s.dispose();
    });
  });

  describe("screenShown", () => {
    it("is always false in a wide window, and comes back when the window narrows", () => {
      const s = setup({ twoPane: true });
      s.panel.setScreen(true);
      expect(s.panel.screenShown()).toBe(false);

      s.setTwoPane(false);
      expect(s.panel.screenShown()).toBe(true);
      s.dispose();
    });
  });

  describe("open", () => {
    it("needs both a wide window and the pin", () => {
      const s = setup({ twoPane: false, pinned: true });
      expect(s.panel.open()).toBe(false);

      s.setTwoPane(true);
      expect(s.panel.open()).toBe(true);
      s.dispose();
    });
  });

  it("starts with the details folded", () => {
    const s = setup();
    expect(s.panel.detailsOpen()).toBe(false);

    s.panel.setDetailsOpen(true);
    expect(s.panel.detailsOpen()).toBe(true);
    s.dispose();
  });
});
