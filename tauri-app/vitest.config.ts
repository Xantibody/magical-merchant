import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
  plugins: [solid()],
  optimizeDeps: {
    // 実行中に発見された依存は再最適化とページリロードを引き起こし、Vitest が
    // 「Vite unexpectedly reloaded a test」と警告する。テストからしか使わない
    // @tauri-apps/api/mocks は取りこぼしやすいので明示しておく。
    include: [
      "markdown-it",
      "shiki",
      "mermaid",
      "@solidjs/testing-library",
      "@tauri-apps/api/mocks",
    ],
  },
  test: {
    setupFiles: ["./src/test-setup.ts"],
    browser: {
      provider: playwright(),
      enabled: true,
      instances: [{ browser: "chromium" }],
    },
  },
});
