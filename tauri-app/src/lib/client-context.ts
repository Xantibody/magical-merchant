import {
  checkPermissions,
  requestPermissions,
  getCurrentPosition,
} from "@tauri-apps/plugin-geolocation";
import { createLocationTracker } from "./location-tracker";

export type NetworkType = "WiFi" | "Ethernet" | "Mobile" | "Offline";

/**
 * ネイティブ側では取れない実行環境の情報。Android には `battery` クレートも
 * SystemConfiguration も無く、Rust 側は一律 `None` を返すしかない。
 * WebView が持っている値で埋めて Tauri コマンドに渡す。
 */
export interface ClientContext {
  latitude: number | null;
  longitude: number | null;
  battery: number | null;
  isCharging: boolean | null;
  networkType: NetworkType | null;
  osVersion: string | null;
  locale: string | null;
}

interface BatteryStatus {
  level: number;
  charging: boolean;
}

/** Battery Status API は標準の lib.dom から外れているので自前で型を置く。 */
interface BatteryCapableNavigator extends Navigator {
  getBattery?: () => Promise<BatteryStatus>;
}

/** Network Information API も同様。`type` は Chromium の Android ビルドにしか無い。 */
interface ConnectionCapableNavigator extends Navigator {
  connection?: { type?: string };
}

export function parseAndroidVersion(userAgent: string): string | null {
  return /Android (?<version>\d+(?:\.\d+)*)/u.exec(userAgent)?.groups?.version ?? null;
}

export function toNetworkType(online: boolean, connectionType?: string): NetworkType | null {
  if (!online) {
    return "Offline";
  }
  switch (connectionType) {
    case "wifi": {
      return "WiFi";
    }
    case "ethernet": {
      return "Ethernet";
    }
    case "cellular": {
      return "Mobile";
    }
    case "none": {
      return "Offline";
    }
    // bluetooth / wimax / unknown、あるいは API 自体が無いブラウザ。
    // 分からないものを WiFi に丸めると記録が嘘になるので黙って諦める。
    default: {
      return null;
    }
  }
}

export function toBatteryPercent(level: number): number {
  return Math.min(100, Math.max(0, Math.round(level * 100)));
}

async function readBattery(): Promise<Pick<ClientContext, "battery" | "isCharging">> {
  const { getBattery } = navigator as BatteryCapableNavigator;
  if (!getBattery) {
    return { battery: null, isCharging: null };
  }
  try {
    const status = await getBattery.call(navigator);
    return { battery: toBatteryPercent(status.level), isCharging: status.charging };
  } catch {
    return { battery: null, isCharging: null };
  }
}

async function locationPermitted(request: boolean): Promise<boolean> {
  let permissions = await checkPermissions();
  if (
    request &&
    (permissions.location === "prompt" || permissions.location === "prompt-with-rationale")
  ) {
    permissions = await requestPermissions(["location"]);
  }
  return permissions.location === "granted";
}

/**
 * Android の GPS はコールドスタートで数秒かかるので、保存のたびに測り直すと
 * 送信がそのぶん止まる。手元の座標を使い回し、測位は裏で回して次に備える。
 * macOS がネイティブ側で「起動と同時に受け取り始める」のと同じ理屈。
 */
const locationTracker = createLocationTracker({
  permitted: locationPermitted,
  position: async () => {
    const pos = await getCurrentPosition();
    return { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
  },
});

/** 許可ダイアログを出さずに測位を始めておく。起動時に呼ぶ。 */
export function warmLocation(): void {
  locationTracker.warmUp();
}

/**
 * 端末に聞くだけで分かる情報を集める。位置情報だけは許可ダイアログを伴うので
 * 含めない。自動保存のように頻繁に走る経路はこちらを使う。
 * 取れないものは null で、呼び出しは失敗させない。
 */
export async function getDeviceSignals(): Promise<ClientContext> {
  return {
    latitude: null,
    longitude: null,
    ...(await readBattery()),
    networkType: toNetworkType(
      navigator.onLine,
      (navigator as ConnectionCapableNavigator).connection?.type,
    ),
    osVersion: parseAndroidVersion(navigator.userAgent),
    locale: navigator.language ? navigator.language.replace("-", "_") : null,
  };
}

/** 端末情報に位置情報を足したもの。ユーザーが明示的に記録した瞬間だけ使う。 */
export async function getClientContext(): Promise<ClientContext> {
  const [signals, location] = await Promise.all([getDeviceSignals(), locationTracker.read()]);
  return { ...signals, ...location };
}
