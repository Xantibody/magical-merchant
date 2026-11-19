import { describe, it, expect } from "vitest";
import { placeBesideTrigger } from "./popover-place";

const phone = { width: 390, height: 800 };
const wide = { width: 1280, height: 800 };

describe("placeBesideTrigger", () => {
  // The band is at the foot, so the button that opens the calendar is too: it opens over the
  // button, not at the far end of the screen
  it("opens above a trigger at the foot, its right edge on the trigger's", () => {
    const place = placeBesideTrigger({ top: 687, bottom: 711, right: 362 }, phone, 305);

    expect(place).toStrictEqual({ top: "auto", bottom: "121px", right: "28px" });
  });

  it("follows the trigger across a wide window", () => {
    const place = placeBesideTrigger({ top: 678, bottom: 702, right: 1014 }, wide, 305);

    expect(place).toStrictEqual({ top: "auto", bottom: "130px", right: "266px" });
  });

  // The scrubber's tab sits right at the edge: the popover keeps a gutter of its own
  it("keeps off the window's edge", () => {
    const place = placeBesideTrigger({ top: 400, bottom: 464, right: 390 }, phone, 305);

    expect(place.right).toBe("8px");
  });

  it("opens below a trigger with no room above it", () => {
    const place = placeBesideTrigger({ top: 40, bottom: 64, right: 362 }, phone, 305);

    expect(place).toStrictEqual({ top: "72px", right: "28px" });
  });

  // No trigger (a key opened it): the stylesheet's own place stands
  it("leaves the place to the stylesheet without a trigger", () => {
    expect(placeBesideTrigger(undefined, phone, 305)).toStrictEqual({});
  });
});
