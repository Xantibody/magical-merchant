export interface Coordinates {
  latitude: number | null;
  longitude: number | null;
}

const NO_LOCATION: Coordinates = { latitude: null, longitude: null };

/**
 * 保存が測位を待つ時間の上限。Android の GPS はコールドスタートで数秒かかる
 * ことがあり、そのあいだ送信を止めると「即座に保存される」が壊れる。
 * ここを過ぎたら位置なしで保存を進め、遅れて届いたフィックスは次の保存が使う。
 */
export const LOCATION_BUDGET_MS = 1500;

interface TrackerDeps {
  /** 位置情報の許可を確かめる。request が true のときだけダイアログを出してよい。 */
  permitted: (request: boolean) => Promise<boolean>;
  position: () => Promise<Coordinates>;
  budgetMs?: number;
}

export interface LocationTracker {
  /** ダイアログを出さずにキャッシュを温める。起動時に呼ぶ。 */
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
    // 追い越されていたら後発の飛行が inflight を持っている。触らない。
    if (inflight?.id === id) {
      inflight = null;
    }
    return result;
  };

  const refresh = (request: boolean): Promise<Coordinates> => {
    // 進行中の測位に相乗りする。ただし許可を求めない飛行中に「求めてよい」
    // 呼び出しが来たら、乗らずに新しく飛ばす。乗ると初回の許可ダイアログが
    // いつまでも出ない。
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
    // 手元に座標があるなら待たずに使う。記録したいのは「どのあたりで書いたか」
    // であって、いま始めた測位の結果は次の保存に間に合えばよい。
    if (lastKnown) {
      return Promise.resolve(lastKnown);
    }
    // タイムアウトを Promise にする手段は executor を書く以外に無い
    // oxlint-disable-next-line promise/avoid-new
    const giveUp = new Promise<Coordinates>((resolve) => {
      setTimeout(() => resolve(lastKnown ?? NO_LOCATION), budget);
    });
    return Promise.race([fix, giveUp]);
  };

  return { warmUp: () => void refresh(false), read };
}
