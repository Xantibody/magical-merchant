import { describe, it, expect, afterEach, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { setLocale } from "./i18n";
import { createPlaceStore, placeKey } from "./places";
import type { DeviceContext } from "./parse-timeline";

function at(latitude: number, longitude: number): DeviceContext {
  return { os: "android", arch: "aarch64", location: { latitude, longitude } };
}

/** `resolve_places` に渡された引数を控えつつ、`answers` を返す。 */
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

afterEach(() => clearMocks());

describe("placeKey", () => {
  /** Rust 側の `place_key` と同じ丸めでないと、答えを引き当てられない。 */
  it("rounds to the same grid the cache is keyed by", () => {
    expect(placeKey(35.676_140_3, 139.546_563_4)).toBe("35.68,139.55");
  });

  it("keeps the hemisphere", () => {
    expect(placeKey(-33.86, -70.66)).toBe("-33.86,-70.66");
  });
});

describe("createPlaceStore", () => {
  it("names a coordinate once it has been resolved", async () => {
    const store = createPlaceStore();
    mockPlaces([["35.68,139.55", "渋谷区"]]);

    await store.load([at(35.676_140_3, 139.546_563_4)]);

    expect(store.nameOf({ latitude: 35.676_140_3, longitude: 139.546_563_4 })).toBe("渋谷区");
  });

  /** 同じ町で書いた 1 日ぶんの記録に、同じ問い合わせを何十回もさせない。 */
  it("asks about each grid square only once", async () => {
    const store = createPlaceStore();
    const { calls } = mockPlaces([["35.68,139.55", "渋谷区"]]);

    await store.load([at(35.6761, 139.5465), at(35.6769, 139.5469), at(35.6517, 139.5446)]);

    expect(calls[0]).toEqual([
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
   * 圏外では 1 件も返らない。同じ座標をその都度聞き直すと、タイムラインが
   * 再描画されるたびに返らない IPC を積み上げる。
   */
  it("does not retry a coordinate the OS could not name", async () => {
    const store = createPlaceStore();
    const { calls } = mockPlaces([]);
    await store.load([at(35.6761, 139.5465)]);

    await store.load([at(35.6761, 139.5465)]);

    expect(calls).toHaveLength(1);
  });

  /** 地名は OS が言語ごとに違う答えを返す。どの言語で聞くかを渡す。 */
  it("asks in the language the interface is in", async () => {
    const store = createPlaceStore();
    const { locales } = mockPlaces([["35.68,139.55", "Shibuya"]]);
    setLocale("en");

    await store.load([at(35.6761, 139.5465)]);

    expect(locales).toStrictEqual(["en"]);
  });

  /**
   * 言語を変えたら地名も変わる。前の言語の答えを残すと、英語の画面に
   * 日本語の地名が並んだままになる。
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

  /** 地名が出ないことより、タイムラインが出ないことのほうが困る。 */
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
