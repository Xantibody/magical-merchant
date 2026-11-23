// shoot <dir>: starts the real app over a fresh copy of fixtures/ and writes, for every scene at
// every width, language and theme, its picture (<shot>.png) and its accessibility tree
// (<shot>.txt), named <scene>.<width>.<language>.<theme>.

import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { startApp } from "../services/app.ts";
import type { App } from "../services/app.ts";
import { inOrder } from "../utils/order.ts";
import { collectTree, treeText } from "../utils/tree.ts";
import { scenes } from "./scenes.ts";
import type { Scene, Width } from "./scenes.ts";
import { settle, stopMotion } from "./still.ts";

function fail(problem: string): never {
  console.error(problem);
  process.exit(2);
}

const { values, positionals } = parseArgs({
  options: {
    app: { type: "string" },
    fixtures: { type: "string" },
    only: { type: "string" },
  },
  allowPositionals: true,
});
const binary = values.app ?? fail("missing --app <the debug binary built from app/>");
const fixtures = values.fixtures ?? fail("missing --fixtures <the repository's fixtures/data>");
const out = resolve(positionals[0] ?? fail("missing <dir> to write the shots into"));
const chosen = scenes.filter(
  (scene) => values.only === undefined || scene.name.includes(values.only),
);

/** The day every shot is taken on: after the newest fixture, and a Friday with an empty today. */
const NOW = Date.parse("2026-08-07T12:00:00+09:00");

/**
 * Inner sizes: the feature tour's wide window, wide enough for a note and its map side by side,
 * and a phone that is only a narrow window (WKWebView still reports a mouse, so no hover: none).
 */
const SIZES: Record<Width, { width: number; height: number }> = {
  wide: { width: 1280, height: 800 },
  phone: { width: 390, height: 844 },
};
const LANGUAGES = ["ja", "en"];
const THEMES = ["light", "dark"];

/**
 * The place names of the fixtures' coordinates, so the rows that carry one never wait on the OS
 * geocoder or the network. Keyed as core's place_names keeps them: language, then the
 * coordinates to two places.
 */
const PLACES = { "ja:35.68,139.77": "千代田区", "en:35.68,139.77": "Chiyoda" };

// A shot left from an earlier run would pass for this one's, so shoot only into a new directory
const earlier = await readdir(out).catch(() => []);
if (earlier.length > 0) {
  fail(`${out} already holds ${earlier.length} files; shoot into a new or empty directory`);
}
await mkdir(out, { recursive: true });

/**
 * Sets the window's inner size, and refuses to go on when something else sized it. WebDriver
 * sizes the window with its title bar, which `chrome` measured at the start.
 */
async function resize(browser: WebdriverIO.Browser, width: Width, chrome: number[]): Promise<void> {
  const want = SIZES[width];
  await browser.setWindowRect(
    null,
    null,
    want.width + (chrome[0] ?? 0),
    want.height + (chrome[1] ?? 0),
  );
  let got: number[] = [];
  const sized = await browser
    .waitUntil(
      async () => {
        got = await browser.execute(() => [window.innerWidth, window.innerHeight]);
        return got[0] === want.width && got[1] === want.height;
      },
      { timeout: 3000, interval: 100 },
    )
    .catch(() => false);
  if (!sized) {
    throw new Error(
      `the window stays ${got.join("x")} inside, not ${want.width}x${want.height}: something else sizes it (a window manager that fits even fixed-size windows into its layout?)`,
    );
  }
}

async function shoot(
  browser: WebdriverIO.Browser,
  scene: Scene,
  width: Width,
  language: string,
  theme: string,
): Promise<void> {
  const storage = {
    "first-run-dismissed": "1",
    locale: language,
    theme,
    ...scene.storage,
  };
  await browser.execute((items: Record<string, string | null>) => {
    localStorage.clear();
    for (const [key, value] of Object.entries(items)) {
      if (value !== null) {
        localStorage.setItem(key, value);
      }
    }
  }, storage);
  await browser.url(new URL(scene.url, await browser.getUrl()).href);
  await browser.$(".app").waitForExist({ timeout: 20_000 });
  await stopMotion(browser);
  await scene.act?.(browser, width);
  const ready = typeof scene.ready === "string" ? scene.ready : scene.ready(width);
  await browser.$(ready).waitForExist({
    timeout: 10_000,
    timeoutMsg: `${scene.name} (${width}) never showed ${ready}`,
  });
  await settle(browser);

  const name = `${scene.name}.${width}.${language}.${theme}`;
  const tree = await browser.execute(collectTree, await browser.$("body"));
  await writeFile(join(out, `${name}.png`), await browser.takeScreenshot(), "base64");
  await writeFile(join(out, `${name}.txt`), treeText(tree));
  console.log(join(out, `${name}.png`));
}

async function shootAll(browser: WebdriverIO.Browser, failed: string[]): Promise<void> {
  await browser.$(".app").waitForExist({ timeout: 20_000 });
  // WKWebView answers 0 for outerWidth, so the outside comes from WebDriver's own rect
  const outer = await browser.getWindowRect();
  const inner = await browser.execute(() => [window.innerWidth, window.innerHeight]);
  const chrome = [outer.width - (inner[0] ?? 0), outer.height - (inner[1] ?? 0)];
  // One window, so one shot at a time; the window is sized once per width
  await inOrder(
    (["wide", "phone"] as const).map((width) => async () => {
      await resize(browser, width, chrome);
      await inOrder(
        LANGUAGES.flatMap((language) =>
          THEMES.flatMap((theme) =>
            chosen
              .filter((scene) => scene.widths.includes(width))
              .map((scene) => async () => {
                // One scene that cannot be reached says so and leaves the others their shots
                await shoot(browser, scene, width, language, theme).catch((error: unknown) => {
                  failed.push(
                    `${scene.name}.${width}.${language}.${theme}: ${String(error).split("\n")[0]}`,
                  );
                });
              }),
          ),
        ),
      );
    }),
  );
  await writeFile(
    join(out, "manifest.json"),
    `${JSON.stringify(
      {
        now: new Date(NOW).toISOString(),
        ...(await browser.execute(() => ({
          devicePixelRatio: window.devicePixelRatio,
          timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
        }))),
      },
      null,
      2,
    )}\n`,
  );
}

const base = await mkdtemp(join(tmpdir(), "mm-screens-"));
let app: App | undefined;
let cleaning: Promise<void> | undefined;
/** Stops the app, whose server would take scripts from anyone, and drops the copy of fixtures. */
const cleanUp = (): Promise<void> =>
  (cleaning ??= (async () => {
    try {
      await app?.stop();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  })());
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, async () => {
    try {
      await cleanUp();
    } finally {
      process.exit(128 + constants.signals[signal]);
    }
  });
}

const failed: string[] = [];
try {
  await cp(fixtures, join(base, "data"), { recursive: true });
  await writeFile(join(base, "places.json"), JSON.stringify(PLACES));
  app = await startApp({
    binary,
    dataDir: base,
    env: { MAGICAL_MERCHANT_NOW_MS: String(NOW) },
  });
  await shootAll(app.browser, failed);
} finally {
  await cleanUp();
}

if (failed.length > 0) {
  console.error(`${failed.length} shots not taken:\n${failed.join("\n")}`);
  process.exitCode = 1;
}
