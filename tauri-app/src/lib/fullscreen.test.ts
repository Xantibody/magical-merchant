import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";
import {
  applyStartFullscreen,
  enterFullscreen,
  readStartFullscreen,
  writeStartFullscreen,
} from "./fullscreen";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36";

interface Invoked {
  cmd: string;
  args: Record<string, unknown>;
}

const invoked: Invoked[] = [];

// vi.mock ではなく mockIPC を使う理由は commands.test.ts に書いたとおり
function mockWindow(fail = false): void {
  mockWindows("main");
  mockIPC((cmd, args) => {
    invoked.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
    if (fail) {
      throw new Error("no window");
    }
    return null;
  });
}

describe("start-fullscreen setting", () => {
  beforeEach(() => {
    localStorage.clear();
    invoked.length = 0;
  });

  afterEach(() => {
    clearMocks();
    localStorage.clear();
  });

  it("is off until someone turns it on", () => {
    expect(readStartFullscreen()).toBe(false);
  });

  it("remembers being turned on", () => {
    writeStartFullscreen(true);
    expect(readStartFullscreen()).toBe(true);
  });

  it("remembers being turned off again", () => {
    writeStartFullscreen(true);
    writeStartFullscreen(false);
    expect(readStartFullscreen()).toBe(false);
  });
});

describe("applyStartFullscreen", () => {
  beforeEach(() => {
    localStorage.clear();
    invoked.length = 0;
    mockWindow();
  });

  afterEach(() => {
    clearMocks();
    localStorage.clear();
  });

  it("asks the window for fullscreen on a Mac with the setting on", async () => {
    writeStartFullscreen(true);

    await applyStartFullscreen(MAC);

    expect(invoked).toHaveLength(1);
    expect(invoked[0].cmd).toBe("plugin:window|set_fullscreen");
    expect(invoked[0].args.value).toBe(true);
  });

  it("leaves the window alone when the setting is off", async () => {
    await applyStartFullscreen(MAC);

    expect(invoked).toHaveLength(0);
  });

  // Android に全画面の窓は無い。設定が同期されて残っていても触らない
  it("leaves the window alone off a Mac even with the setting on", async () => {
    writeStartFullscreen(true);

    await applyStartFullscreen(ANDROID);

    expect(invoked).toHaveLength(0);
  });

  // ブラウザハーネスやテストでは窓が無い。起動を落とす理由にはならない
  it("resolves even when the window refuses", async () => {
    mockWindow(true);
    writeStartFullscreen(true);

    await expect(applyStartFullscreen(MAC)).resolves.toBeUndefined();
  });
});

describe("enterFullscreen", () => {
  afterEach(() => {
    clearMocks();
  });

  it("resolves when there is no Tauri window at all", async () => {
    clearMocks();

    await expect(enterFullscreen()).resolves.toBeUndefined();
  });
});
