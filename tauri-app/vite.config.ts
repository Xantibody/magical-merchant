import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import type { PluginOption } from "vite";

const host = process.env.TAURI_DEV_HOST;

/**
 * `BROWSER_MOCK=1` の dev サーバーだけ、Tauri IPC のモックを index.html の
 * 先頭にインライン注入する。agent-browser など普通のブラウザで UI を検証する
 * ための入り口で、ビルド成果物には何も足さない。
 */
function browserMock(): PluginOption {
  if (!process.env.BROWSER_MOCK) {
    return false;
  }
  return {
    name: "browser-ipc-mock",
    apply: "serve",
    transformIndexHtml: {
      order: "pre",
      handler: () => [
        {
          tag: "script",
          children: readFileSync(new URL("dev/ipc-mock.js", import.meta.url), "utf8"),
          injectTo: "head-prepend",
        },
      ],
    },
  };
}

export default defineConfig(async () => ({
  plugins: [solid(), browserMock()],

  clearScreen: false,
  // Two pages: the app, and the one-line window the global key floats over other apps
  // (src-tauri/src/capture.rs)
  build: {
    rollupOptions: {
      input: {
        // Named after the page, so the app's entry chunk keeps the name its size is measured by
        index: new URL("index.html", import.meta.url).pathname,
        capture: new URL("capture.html", import.meta.url).pathname,
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
