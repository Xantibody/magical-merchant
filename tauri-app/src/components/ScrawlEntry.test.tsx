import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, waitFor } from "@solidjs/testing-library";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import ScrawlEntry from "./ScrawlEntry";
import { toScrawlItems } from "../lib/items";
import { placeKey, places } from "../lib/places";
import type { DeviceContext } from "../lib/parse-scrawl";

function at(latitude: number, longitude: number): DeviceContext {
  return { os: "macos", arch: "aarch64", location: { latitude, longitude } };
}

/** One record written at `context`, drawn the way Scrawl draws it. */
function renderEntry(context: DeviceContext): HTMLElement {
  const [item] = toScrawlItems("2026-11-08", [`- [09:00:00] walk ${JSON.stringify(context)}`]);
  const { container } = render(() => (
    <ScrawlEntry
      item={item}
      notes={[]}
      selecting={false}
      selected={false}
      onToggle={vi.fn<() => void>()}
      onPromote={vi.fn<() => void>()}
      onOpenNote={vi.fn<() => void>()}
      onUnlinkNote={vi.fn<() => void>()}
    />
  ));
  return container;
}

/** Answer `resolve_places` with a name for each coordinate asked about. */
function answerPlaces(name: string): void {
  mockIPC((cmd, payload) => {
    if (cmd !== "resolve_places") {
      return null;
    }
    const { coordinates } = payload as { coordinates: [number, number][] };
    return coordinates.map(([latitude, longitude]) => [placeKey(latitude, longitude), name]);
  });
}

const metaParts = (container: HTMLElement): Element[] => [
  ...container.querySelectorAll(".entry-meta-part"),
];

describe("ScrawlEntry › meta row", () => {
  afterEach(() => {
    cleanup();
    clearMocks();
  });

  // Every place lookup swaps the whole table of names, and a page of entries written with a
  // location would each redraw their row and its icons for a name that is someone else's
  it("leaves its row alone when another record's place resolves", async () => {
    const container = renderEntry(at(12.3456, 65.4321));
    const before = metaParts(container);
    answerPlaces("elsewhere");

    await places.load([at(-1.2345, -4.5678)]);

    const after = metaParts(container);
    expect(after).toHaveLength(before.length);
    for (const [index, part] of after.entries()) {
      expect(part).toBe(before[index]);
    }
  });

  it("names its own place once it resolves", async () => {
    const container = renderEntry(at(23.4567, 76.5432));
    answerPlaces("Harbour");

    await places.load([at(23.4567, 76.5432)]);

    await waitFor(() =>
      expect(container.querySelector(".entry-meta")?.textContent).toContain("Harbour"),
    );
  });
});
