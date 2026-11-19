export interface Coordinates {
  latitude: number | null;
  longitude: number | null;
}

const NO_LOCATION: Coordinates = { latitude: null, longitude: null };

/**
 * Upper bound on the time a save waits for a fix. Android GPS can take several
 * seconds on a cold start, and holding the write back for that long breaks "it
 * saves immediately". Past this point the save proceeds without a location, and a
 * fix that arrives late is used by the next save.
 */
export const LOCATION_BUDGET_MS = 1500;

interface TrackerDeps {
  /** Checks the location permission. Only a `request` of true may show the dialog. */
  permitted: (request: boolean) => Promise<boolean>;
  position: () => Promise<Coordinates>;
  budgetMs?: number;
}

export interface LocationTracker {
  /** Warms the cache without showing a dialog. Call it at startup. */
  warmUp: () => void;
  read: () => Promise<Coordinates>;
}

interface Flight {
  id: number;
  request: boolean;
  promise: Promise<Coordinates>;
}

export function createLocationTracker(deps: TrackerDeps): LocationTracker {
  const budget = deps.budgetMs ?? LOCATION_BUDGET_MS;
  let lastKnown: Coordinates | null = null;
  let inflight: Flight | null = null;
  let flightCount = 0;

  const locate = async (request: boolean): Promise<Coordinates> => {
    try {
      if (!(await deps.permitted(request))) {
        return lastKnown ?? NO_LOCATION;
      }
      lastKnown = await deps.position();
      return lastKnown;
    } catch {
      return lastKnown ?? NO_LOCATION;
    }
  };

  const launch = async (id: number, request: boolean): Promise<Coordinates> => {
    const result = await locate(request);
    // If this flight was overtaken, a later one owns `inflight`. Leave it alone.
    if (inflight?.id === id) {
      inflight = null;
    }
    return result;
  };

  const refresh = (request: boolean): Promise<Coordinates> => {
    // Ride along with a fix already in flight. But when a call that may ask for
    // permission arrives while a flight that does not ask is running, start a new
    // flight instead of joining. Joining would never show the first permission
    // dialog.
    if (inflight && (inflight.request || !request)) {
      return inflight.promise;
    }
    flightCount += 1;
    const id = flightCount;
    inflight = { id, request, promise: launch(id, request) };
    return inflight.promise;
  };

  const read = (): Promise<Coordinates> => {
    const fix = refresh(true);
    // Use coordinates already at hand instead of waiting. What we record is
    // "roughly where this was written", so the fix just started only has to be
    // ready in time for the next save.
    if (lastKnown) {
      return Promise.resolve(lastKnown);
    }
    // Writing an executor is the only way to turn a timeout into a Promise
    // oxlint-disable-next-line promise/avoid-new
    const giveUp = new Promise<Coordinates>((resolve) => {
      setTimeout(() => resolve(lastKnown ?? NO_LOCATION), budget);
    });
    return Promise.race([fix, giveUp]);
  };

  return {
    warmUp: () => {
      void refresh(false);
    },
    read,
  };
}
