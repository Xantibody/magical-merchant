/**
 * The cache of place names attached to coordinates.
 *
 * The OS does the lookup, and the native side also keeps the answer on disk. What lives
 * here is only "the place names this screen can show right now"; it never touches the
 * records themselves.
 */

import { createSignal } from "solid-js";
import { typedInvoke } from "./commands";
import { locale } from "./i18n";
import type { DeviceContext } from "./parse-scrawl";

interface Coordinate {
  latitude: number;
  longitude: number;
}

/** The rounding digits. Unless they match `place_key` on the Rust side, no answer is found. */
const KEY_DIGITS = 2;

export function placeKey(latitude: number, longitude: number): string {
  return `${latitude.toFixed(KEY_DIGITS)},${longitude.toFixed(KEY_DIGITS)}`;
}

export interface PlaceStore {
  /** The place name if it is known. undefined until then, and the caller shows the coordinates. */
  nameOf: (location: Coordinate) => string | undefined;
  /** Ask, in one go, for the coordinates not asked about yet among the records about to be shown. */
  load: (contexts: readonly (DeviceContext | null)[]) => Promise<void>;
}

export function createPlaceStore(): PlaceStore {
  const [names, setNames] = createSignal<ReadonlyMap<string, string>>(new Map());
  /**
   * The coordinates already asked about, including the ones that came back with no answer.
   * Allowing a coordinate that failed out of signal range to be asked again would send an
   * IPC every time a record with no place name appears on screen. The next time the app
   * opens it asks again, so a miss lasts only one session.
   */
  const asked = new Set<string>();
  /** The language the place names now held were looked up in. If it changes, ask for all of them again. */
  let askedIn = locale();

  const nameOf = (location: Coordinate): string | undefined =>
    names().get(placeKey(location.latitude, location.longitude));

  const load = async (contexts: readonly (DeviceContext | null)[]): Promise<void> => {
    // The OS returns a different place name per language. Keeping what was looked up in
    // the previous language leaves Japanese place names lined up on an English screen
    if (askedIn !== locale()) {
      askedIn = locale();
      asked.clear();
      setNames(new Map());
    }
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
      const resolved = await typedInvoke("resolve_places", {
        coordinates: pending,
        locale: askedIn,
      });
      if (resolved.length > 0) {
        setNames((known) => new Map([...known, ...resolved]));
      }
    } catch {
      // A place name is only decoration on a record. Stopping Scrawl because the lookup
      // failed does more harm, so show the coordinates as they are and say nothing.
    }
  };

  return { nameOf, load };
}

/** The single store, so the same answers are reused across screens. */
export const places = createPlaceStore();
