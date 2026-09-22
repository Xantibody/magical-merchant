import { describe, it, expect, afterEach, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { setLocale } from "./i18n";
import { createPlaceStore, placeKey } from "./places";
import type { DeviceContext } from "./parse-scrawl";

function at(latitude: number, longitude: number): DeviceContext {
  return { os: "android", arch: "aarch64", location: { latitude, longitude } };
}

/** Record the arguments passed to `resolve_places` while returning `answers`. */
function mockPlaces(answers: [string, string][]): {
  calls: [number, number][][];
  locales: string[];
} {
  const calls: [number, number][][] = [];
  const locales: string[] = [];
  mockIPC((cmd, payload) => {
    if (cmd !== "resolve_places") {
      return null;
    }
    const args = payload as { coordinates: [number, number][]; locale: string };
    calls.push(args.coordinates);
    locales.push(args.locale);
    return answers;
  });
  return { calls, locales };
}

describe("placeKey", () => {
  /** Without the same rounding as `place_key` on the Rust side, the answer is never found. */
  it("rounds to the same grid the cache is keyed by", () => {
    expect(placeKey(35.6761403, 139.5465634)).toBe("35.68,139.55");
  });

  it("keeps the hemisphere", () => {
    expect(placeKey(-33.86, -70.66)).toBe("-33.86,-70.66");
  });
});

describe("createPlaceStore", () => {
  afterEach(() => clearMocks());

  it("names a coordinate once it has been resolved", async () => {
    const store = createPlaceStore();
    mockPlaces([["35.68,139.55", "渋谷区"]]);

    await store.load([at(35.6761403, 139.5465634)]);

    expect(store.nameOf({ latitude: 35.6761403, longitude: 139.5465634 })).toBe("渋谷区");
  });

  /** A day of records written in one town must not repeat the same query dozens of times. */
  it("asks about each grid square only once", async () => {
    const store = createPlaceStore();
    const { calls } = mockPlaces([["35.68,139.55", "渋谷区"]]);

    await store.load([at(35.6761, 139.5465), at(35.6769, 139.5469), at(35.6517, 139.5446)]);

    expect(calls[0]).toStrictEqual([
      [35.6761, 139.5465],
      [35.6517, 139.5446],
    ]);
  });

  it("does not ask again about a coordinate it already knows", async () => {
    const store = createPlaceStore();
    const { calls } = mockPlaces([["35.68,139.55", "渋谷区"]]);
    await store.load([at(35.6761, 139.5465)]);

    await store.load([at(35.6761, 139.5465)]);

    expect(calls).toHaveLength(1);
  });

  /**
   * Out of range nothing comes back. Asking about the same coordinate every time would
   * pile up IPC calls that never answer on each Scrawl re-render.
   */
  it("does not retry a coordinate the OS could not name", async () => {
    const store = createPlaceStore();
    const { calls } = mockPlaces([]);
    await store.load([at(35.6761, 139.5465)]);

    await store.load([at(35.6761, 139.5465)]);

    expect(calls).toHaveLength(1);
  });

  /** The OS answers a place name differently per language. Pass which language to ask in. */
  it("asks in the language the interface is in", async () => {
    const store = createPlaceStore();
    const { locales } = mockPlaces([["35.68,139.55", "Shibuya"]]);
    setLocale("en");

    await store.load([at(35.6761, 139.5465)]);

    expect(locales).toStrictEqual(["en"]);
  });

  /**
   * Change the language and the place names change too. Keeping the previous language's
   * answers leaves Japanese place names standing on an English screen.
   */
  it("forgets what it knows when the language changes", async () => {
    const store = createPlaceStore();
    mockPlaces([["35.68,139.55", "渋谷区"]]);
    await store.load([at(35.6761, 139.5465)]);

    setLocale("en");
    const { calls } = mockPlaces([["35.68,139.55", "Shibuya"]]);
    await store.load([at(35.6761, 139.5465)]);

    expect(calls).toHaveLength(1);
    expect(store.nameOf({ latitude: 35.6761, longitude: 139.5465 })).toBe("Shibuya");
  });

  it("has no name for a coordinate nobody asked about", () => {
    expect(createPlaceStore().nameOf({ latitude: 35.6761, longitude: 139.5465 })).toBeUndefined();
  });

  it("skips entries recorded without a location", async () => {
    const store = createPlaceStore();
    const { calls } = mockPlaces([]);

    await store.load([{ os: "macos", arch: "aarch64" }]);

    expect(calls).toHaveLength(0);
  });

  /** A missing place name is less trouble than a missing Scrawl. */
  it("stays quiet when the lookup fails", async () => {
    const store = createPlaceStore();
    const failed = vi.fn<() => void>();
    mockIPC(() => {
      throw new Error("no geocoder");
    });

    await store.load([at(35.6761, 139.5465)]).catch(failed);

    expect(failed).not.toHaveBeenCalled();
    expect(store.nameOf({ latitude: 35.6761, longitude: 139.5465 })).toBeUndefined();
  });
});
