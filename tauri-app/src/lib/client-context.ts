import {
  checkPermissions,
  requestPermissions,
  getCurrentPosition,
} from "@tauri-apps/plugin-geolocation";
import { createLocationTracker } from "./location-tracker";

export type NetworkType = "WiFi" | "Ethernet" | "Mobile" | "Offline";

/**
 * Runtime information the native side cannot get. Android has neither the `battery` crate
 * nor SystemConfiguration, and the Rust side can only return `None` across the board.
 * Filled with the values the WebView holds and passed to the Tauri command.
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

/** The Battery Status API is outside the standard lib.dom, so the type is declared here. */
interface BatteryCapableNavigator extends Navigator {
  getBattery?: () => Promise<BatteryStatus>;
}

/** The Network Information API likewise. `type` exists only in Chromium's Android build. */
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
    // bluetooth / wimax / unknown, or a browser without the API at all.
    // Rounding something unknown to WiFi would make the record a lie, so give up silently.
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
 * Android's GPS takes seconds on a cold start, so measuring again on every save stalls the
 * send for that long. The coordinates at hand are reused and the fix runs behind, ready
 * for the next one. Same reasoning as macOS "start receiving at launch" on the native side.
 */
const locationTracker = createLocationTracker({
  permitted: locationPermitted,
  position: async () => {
    const pos = await getCurrentPosition();
    return { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
  },
});

/** Start locating without raising the permission dialog. Called at startup. */
export function warmLocation(): void {
  locationTracker.warmUp();
}

/**
 * Collect what can be known by asking the device alone. Location is the one thing left
 * out, because it comes with a permission dialog. Paths that run often, such as autosave,
 * use this one. What cannot be read is null, and the call is never failed.
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

/** The device information plus the location. Used only when the user records explicitly. */
export async function getClientContext(): Promise<ClientContext> {
  const [signals, location] = await Promise.all([getDeviceSignals(), locationTracker.read()]);
  return { ...signals, ...location };
}
