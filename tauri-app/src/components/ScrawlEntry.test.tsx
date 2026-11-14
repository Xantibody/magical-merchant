import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, waitFor, fireEvent, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
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
      open={false}
      onOpenChange={vi.fn<(open: boolean) => void>()}
      onToggle={vi.fn<() => void>()}
      onPromote={vi.fn<() => void>()}
      onCopy={vi.fn<() => void>()}
      onDelete={vi.fn<() => Promise<void>>().mockResolvedValue()}
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

/** A record written on a phone with everything recorded, drawn openable. */
function renderOpenable(onDelete = vi.fn<() => Promise<void>>().mockResolvedValue()): HTMLElement {
  const context: DeviceContext = {
    os: "android",
    arch: "aarch64",
    os_version: "15",
    network_type: "Mobile",
    battery: 49,
    s: "widget",
  };
  const [item] = toScrawlItems("2026-11-08", [`- [09:00:00] walk ${JSON.stringify(context)}`]);
  const [open, setOpen] = createSignal(false);
  const { container } = render(() => (
    <ScrawlEntry
      item={item}
      notes={[]}
      selecting={false}
      selected={false}
      open={open()}
      onOpenChange={setOpen}
      onToggle={vi.fn<() => void>()}
      onPromote={vi.fn<() => void>()}
      onCopy={vi.fn<() => void>()}
      onDelete={onDelete}
      onOpenNote={vi.fn<() => void>()}
      onUnlinkNote={vi.fn<() => void>()}
    />
  ));
  return container;
}

describe("ScrawlEntry › opened by a tap", () => {
  afterEach(() => {
    cleanup();
    clearMocks();
  });

  // S3: one line under the record, the phone's state left for when it is opened
  it("shows one brief meta line until opened, then all of it", () => {
    const container = renderOpenable();
    expect(container.querySelector(".entry-meta")?.textContent).toBe("ウィジェット");

    fireEvent.click(screen.getByText("walk"));

    const full = String(container.querySelector(".entry-meta--full")?.textContent);
    expect(full).toContain("android 15");
    expect(full).toContain("49%");
  });

  it("offers copy, a Note and delete once opened, and folds on a second tap", () => {
    renderOpenable();

    fireEvent.click(screen.getByText("walk"));
    const toolbar = screen.getByRole("toolbar", { name: "この記録の操作" });
    expect([...toolbar.querySelectorAll("button")].map((b) => b.textContent)).toStrictEqual([
      "コピー",
      "Note にする",
      "削除",
    ]);

    fireEvent.click(screen.getByText("walk"));
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  // 96: no dialog over the journal, and no second bar asking; the press itself has to last
  it("deletes only once the press has been held", async () => {
    const onDelete = vi.fn<() => Promise<void>>().mockResolvedValue();
    renderOpenable(onDelete);
    fireEvent.click(screen.getByText("walk"));
    const held = screen.getByRole("button", { name: /^削除 \(/u });

    fireEvent.click(held);
    expect(onDelete).not.toHaveBeenCalled();

    held.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1), { timeout: 1500 });
  });

  it("says how it works when let go too soon", async () => {
    const onDelete = vi.fn<() => Promise<void>>().mockResolvedValue();
    renderOpenable(onDelete);
    fireEvent.click(screen.getByText("walk"));
    const held = screen.getByRole("button", { name: /^削除 \(/u });

    held.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true }));
    // oxlint-disable-next-line promise/avoid-new
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
    held.dispatchEvent(new PointerEvent("pointerup", { pointerType: "mouse", bubbles: true }));

    expect(onDelete).not.toHaveBeenCalled();
    expect(held.textContent).toContain("押し続けて削除");
  });

  // The hover toolbar's trash opens the row onto the held delete; a click alone takes nothing
  it("opens the row from the hover toolbar's trash instead of deleting", () => {
    const onDelete = vi.fn<() => Promise<void>>().mockResolvedValue();
    renderOpenable(onDelete);

    fireEvent.click(screen.getByRole("button", { name: "削除" }));

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("toolbar", { name: "この記録の操作" })).not.toBeNull();
  });
});
