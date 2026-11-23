import { describe, it, expect } from "vitest";
import {
  commitsSlide,
  decideGesture,
  rowDrawer,
  rowStaysOpen,
  slideFollow,
  EDGE_PX,
  MIDDLE_TRAVEL_PX,
  ROW_ACTIONS_PX,
} from "./gesture";
import type { GestureContext } from "./gesture";

/** A press in the middle of a surface's list, on nothing in particular. */
const plain: GestureContext = {
  startX: 180,
  canGoBack: false,
  onRow: false,
  sideScroll: null,
  inText: false,
  onSheetBar: false,
};

const at = (over: Partial<GestureContext>): GestureContext => ({ ...plain, ...over });

/**
 * A thumb's stroke replayed move by move, the way touchmove reports it: what the rule settles
 * on first, which is what the stroke keeps until the finger lifts.
 */
function replay(context: GestureContext, path: [number, number][]): string {
  const [[x0, y0]] = path as [[number, number]];
  for (const [x, y] of path.slice(1)) {
    const answer = decideGesture(context, x - x0, y - y0);
    if (answer !== "pending") {
      return answer;
    }
  }
  return "pending";
}

describe("decideGesture", () => {
  it("waits until the finger has moved past the slop", () => {
    expect(decideGesture(plain, 6, 0)).toBe("pending");
    expect(decideGesture(plain, 0, -7)).toBe("pending");
  });

  describe("a stroke to the right goes one level out", () => {
    it("back, from anywhere on a screen that has a level below it", () => {
      expect(decideGesture(at({ canGoBack: true }), 30, 4)).toBe("back");
      expect(decideGesture(at({ canGoBack: true, startX: 4 }), 30, 4)).toBe("back");
    });

    it("nowhere at the top of a surface: nothing lies further out", () => {
      expect(decideGesture(plain, 30, 4)).toBe("none");
      expect(decideGesture(at({ startX: 2 }), 30, 4)).toBe("none");
    });

    it("from a row too: a row's actions open to the left only", () => {
      expect(decideGesture(at({ onRow: true }), 30, 0)).toBe("none");
      expect(decideGesture(at({ onRow: true, canGoBack: true }), 30, 0)).toBe("back");
    });
  });

  describe("chips that scroll sideways keep the strokes they can answer", () => {
    const chips = { back: true, on: true };
    const onNote = at({ canGoBack: true });

    it("scrolls them in the middle", () => {
      expect(decideGesture(at({ sideScroll: chips }), 30, 0)).toBe("scroll");
      expect(decideGesture(at({ sideScroll: chips }), -30, 0)).toBe("scroll");
    });

    it("goes out once they are at their start", () => {
      expect(decideGesture({ ...onNote, sideScroll: { back: false, on: true } }, 30, 0)).toBe(
        "back",
      );
    });

    it("leaves the left edge going out even over them", () => {
      expect(decideGesture({ ...onNote, sideScroll: chips, startX: EDGE_PX }, 30, 0)).toBe("back");
    });

    it("lets a row behind them open once they are at their end", () => {
      expect(
        decideGesture(at({ sideScroll: { back: true, on: false }, onRow: true }), -30, 0),
      ).toBe("row");
    });
  });

  describe("where text is written the middle is the caret's", () => {
    const writing = at({ inText: true, canGoBack: true });

    it("does nothing with a stroke across the text", () => {
      expect(decideGesture(writing, 30, 0)).toBe("none");
      expect(decideGesture(at({ inText: true, onRow: true }), -30, 0)).toBe("none");
    });

    it("still goes back from the left edge (61: writing gives way to reading)", () => {
      expect(decideGesture({ ...writing, startX: 10 }, 30, 0)).toBe("back");
    });
  });

  it("opens a row with a stroke to the left", () => {
    expect(decideGesture(at({ onRow: true }), -30, 6)).toBe("row");
    expect(decideGesture(plain, -30, 6)).toBe("none");
  });

  describe("vertical strokes", () => {
    it("scroll by default, either way", () => {
      expect(decideGesture(plain, 2, 30)).toBe("scroll");
      expect(decideGesture(plain, 2, -30)).toBe("scroll");
    });

    it("raise the sheet up from the bar", () => {
      expect(decideGesture(at({ onSheetBar: true }), 3, -30)).toBe("sheet");
      expect(decideGesture(at({ onSheetBar: true }), 3, 30)).toBe("scroll");
    });
  });

  describe("vertical is the default", () => {
    it("takes a diagonal as a scroll, whatever lies sideways", () => {
      expect(decideGesture(at({ canGoBack: true }), 20, 20)).toBe("scroll");
      expect(decideGesture(at({ onRow: true }), -20, -14)).toBe("scroll");
      expect(decideGesture(plain, 24, -15)).toBe("scroll");
    });

    it("keeps an arcing scroll that starts left on a row a scroll", () => {
      const arc: [number, number][] = [
        [250, 560],
        [244, 555],
        [239, 551],
        [236, 540],
        [234, 500],
        [233, 400],
      ];
      expect(replay(at({ onRow: true }), arc)).toBe("scroll");
    });

    it("keeps an arcing scroll that starts right a scroll, on a note and at a surface's top", () => {
      const arc: [number, number][] = [
        [150, 560],
        [156, 555],
        [161, 551],
        [164, 540],
        [166, 500],
        [167, 400],
      ];
      expect(replay(plain, arc)).toBe("scroll");
      expect(replay(at({ canGoBack: true }), arc)).toBe("scroll");
    });

    it("lets a slow sideways start that turns upward end as a scroll", () => {
      const turning: [number, number][] = [
        [150, 500],
        [162, 499],
        [170, 497],
        [176, 480],
        [180, 440],
      ];
      expect(replay(at({ canGoBack: true }), turning)).toBe("scroll");
    });
  });

  describe("the middle waits for a longer run than the edge", () => {
    it("holds back until the stroke has run its length", () => {
      expect(decideGesture(at({ canGoBack: true }), 20, 2)).toBe("pending");
      expect(decideGesture(at({ canGoBack: true }), MIDDLE_TRAVEL_PX, 2)).toBe("back");
    });

    it("goes out from the edge as soon as the slop is passed", () => {
      expect(decideGesture(at({ canGoBack: true, startX: 8 }), 12, 1)).toBe("back");
    });

    it("opens a row after a short run of its own", () => {
      expect(decideGesture(at({ onRow: true }), -11, 1)).toBe("pending");
      expect(decideGesture(at({ onRow: true }), -16, 1)).toBe("row");
    });
  });

  describe("a wide window's trackpad", () => {
    const wide = at({ canCover: true });

    it("tucks the level beside the page with a stroke to the left off a row", () => {
      expect(decideGesture(wide, -40, 2)).toBe("cover");
      expect(decideGesture({ ...wide, onRow: true }, -40, 2)).toBe("row");
    });

    it("brings a tucked level back with a stroke to the right", () => {
      expect(decideGesture({ ...wide, canGoBack: true }, 40, 2)).toBe("back");
      expect(decideGesture(wide, 40, 2)).toBe("none");
    });
  });
});

describe("commitsSlide", () => {
  it("goes through past a third of the way", () => {
    expect(commitsSlide({ distance: 140, velocity: 0.1 }, 390)).toBe(true);
    expect(commitsSlide({ distance: 120, velocity: 0.1 }, 390)).toBe(false);
  });

  it("goes through on a flick, however short", () => {
    expect(commitsSlide({ distance: 40, velocity: 0.8 }, 390)).toBe(true);
  });

  it("ignores a fast wobble that went nowhere", () => {
    expect(commitsSlide({ distance: 10, velocity: 0.8 }, 390)).toBe(false);
  });

  // 61: lifting after turning back is "never mind", however far it went first
  it("springs back when the finger turned back before lifting", () => {
    expect(commitsSlide({ distance: 300, velocity: -0.4 }, 390)).toBe(false);
  });
});

describe("rowStaysOpen", () => {
  it("stays open past half its actions, or on a flick", () => {
    expect(rowStaysOpen({ distance: 100, velocity: 0 })).toBe(true);
    expect(rowStaysOpen({ distance: 70, velocity: 0 })).toBe(false);
    expect(rowStaysOpen({ distance: 30, velocity: 0.6 })).toBe(true);
  });

  it("closes when flung back", () => {
    expect(rowStaysOpen({ distance: 140, velocity: -0.5 })).toBe(false);
  });
});

describe("rowDrawer", () => {
  // The actions come in over the row's end; the row itself never moves, so its start (the
  // time, a title) stays where it was read
  it("draws the actions in from the right edge as far as the stroke has come", () => {
    expect(rowDrawer(0)).toBe(ROW_ACTIONS_PX);
    expect(rowDrawer(-50)).toBe(ROW_ACTIONS_PX - 50);
    expect(rowDrawer(-ROW_ACTIONS_PX)).toBe(0);
  });

  it("stops them at their place and off the row's right end", () => {
    expect(rowDrawer(-ROW_ACTIONS_PX - 80)).toBe(0);
    expect(rowDrawer(40)).toBe(ROW_ACTIONS_PX);
  });
});

describe("slideFollow", () => {
  it("follows the finger exactly up to the far end", () => {
    expect(slideFollow(120, 300)).toBe(120);
    expect(slideFollow(-20, 300)).toBe(0);
  });

  it("gives only a little past it", () => {
    expect(slideFollow(400, 300)).toBeLessThan(330);
    expect(slideFollow(400, 300)).toBeGreaterThan(300);
  });
});
