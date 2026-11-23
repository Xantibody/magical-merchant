// The real app, the debug binary built from tests/screens/app: started as a process, driven through
// the WebDriver server that runs inside it (tauri-plugin-wdio-webdriver).

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { remote } from "webdriverio";

export interface App {
  browser: WebdriverIO.Browser;
  stop: () => Promise<void>;
}

export interface Launch {
  /** The binary under target/…/debug. */
  binary: string;
  /** What the app reads as MAGICAL_MERCHANT_DATA_DIR: the directory that holds `data/`. */
  dataDir: string;
  /** More of the app's environment (the pinned clock). */
  env?: Record<string, string>;
  /** How long the server may take to answer ready. */
  timeoutMs?: number;
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  if (address === null || typeof address === "string") {
    throw new Error("the OS gave no TCP port");
  }
  return address.port;
}

async function isReady(port: number): Promise<boolean> {
  try {
    // A server that takes the connection and never answers would otherwise hold one attempt
    // past the deadline
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(2000),
    });
    const body = (await response.json()) as { value?: { ready?: boolean } };
    return body.value?.ready === true;
  } catch {
    // not listening yet
    return false;
  }
}

async function waitReady(child: ChildProcess, port: number, deadline: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`the app exited (${child.exitCode ?? child.signalCode}) before it was ready`);
  }
  if (await isReady(port)) {
    return;
  }
  if (Date.now() > deadline) {
    throw new Error(`the app's WebDriver server on port ${port} was not ready in time`);
  }
  await delay(200);
  await waitReady(child, port, deadline);
}

async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
}

export async function startApp(launch: Launch): Promise<App> {
  const port = await freePort();
  const child = spawn(launch.binary, [], {
    env: {
      ...process.env,
      ...launch.env,
      MAGICAL_MERCHANT_DATA_DIR: launch.dataDir,
      TAURI_WEBDRIVER_PORT: String(port),
    },
    // stdout is this command's result; whatever the app prints is progress
    stdio: ["ignore", process.stderr, process.stderr],
  });
  try {
    await waitReady(child, port, Date.now() + (launch.timeoutMs ?? 60_000));
    const browser = await remote({
      hostname: "127.0.0.1",
      port,
      logLevel: "warn",
      capabilities: {
        // The hidden one-line window exists too; without a label the server picks either
        "wdio:tauriServiceOptions": { windowLabel: "main" },
        "wdio:enforceWebDriverClassic": true,
      } as WebdriverIO.Capabilities,
    });
    return {
      browser,
      stop: async () => {
        try {
          await browser.deleteSession();
        } finally {
          await kill(child);
        }
      },
    };
  } catch (error) {
    await kill(child);
    throw error;
  }
}
