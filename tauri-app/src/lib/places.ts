/**
 * 座標に付ける地名の控え。
 *
 * 引くのは OS で、答えはネイティブ側がディスクにも残す。ここが持つのは
 * 「この画面がいま出せる地名」だけで、記録そのものには一切触らない。
 */

import { createSignal } from "solid-js";
import { typedInvoke } from "./commands";
import type { DeviceContext } from "./parse-timeline";

interface Coordinate {
  latitude: number;
  longitude: number;
}

/** 丸めの桁。Rust 側の `place_key` と揃っていないと答えを引き当てられない。 */
const KEY_DIGITS = 2;

export function placeKey(latitude: number, longitude: number): string {
  return `${latitude.toFixed(KEY_DIGITS)},${longitude.toFixed(KEY_DIGITS)}`;
}

export interface PlaceStore {
  /** 分かっていれば地名。まだなら undefined で、呼び出し側は座標を出す。 */
  nameOf: (location: Coordinate) => string | undefined;
  /** 出そうとしている記録のうち、まだ聞いていない座標をまとめて聞く。 */
  load: (contexts: readonly (DeviceContext | null)[]) => Promise<void>;
}

export function createPlaceStore(): PlaceStore {
  const [names, setNames] = createSignal<ReadonlyMap<string, string>>(new Map());
  /**
   * 一度聞いた座標。答えが返らなかったものも含める。圏外で引けなかった座標を
   * 聞き直せるようにすると、地名の付かない記録が画面に出るたび IPC が飛ぶ。
   * 次にアプリを開けばまた聞くので、取り逃しは 1 セッションで終わる。
   */
  const asked = new Set<string>();

  const nameOf = (location: Coordinate): string | undefined =>
    names().get(placeKey(location.latitude, location.longitude));

  const load = async (contexts: readonly (DeviceContext | null)[]): Promise<void> => {
    const pending: [number, number][] = [];
    for (const context of contexts) {
      const location = context?.location;
      const key = location && placeKey(location.latitude, location.longitude);
      if (location && key && !asked.has(key)) {
        asked.add(key);
        pending.push([location.latitude, location.longitude]);
      }
    }
    if (pending.length === 0) {
      return;
    }

    try {
      const resolved = await typedInvoke("resolve_places", { coordinates: pending });
      if (resolved.length > 0) {
        setNames((known) => new Map([...known, ...resolved]));
      }
    } catch {
      // 地名は記録の飾りでしかない。引けなかったことでタイムラインを
      // 止めるほうが害が大きいので、座標のまま見せて黙る。
    }
  };

  return { nameOf, load };
}

/** 画面をまたいで同じ答えを使い回すための 1 つ。 */
export const places = createPlaceStore();
