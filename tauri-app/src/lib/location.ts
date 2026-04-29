import {
  checkPermissions,
  requestPermissions,
  getCurrentPosition,
} from "@tauri-apps/plugin-geolocation";

interface Coordinates {
  latitude: number;
  longitude: number;
}

export async function getLocation(): Promise<Coordinates | null> {
  try {
    let permissions = await checkPermissions();
    if (permissions.location === "prompt" || permissions.location === "prompt-with-rationale") {
      permissions = await requestPermissions(["location"]);
    }

    if (permissions.location !== "granted") {
      return null;
    }

    const pos = await getCurrentPosition();
    return {
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
    };
  } catch {
    return null;
  }
}
