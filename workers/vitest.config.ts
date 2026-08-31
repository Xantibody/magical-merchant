import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Vitest 4 dropped custom pools, so the Workers runtime arrives as a Vite
// plugin instead of `test.poolOptions.workers`. Same settings, new home.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          GOOGLE_CLIENT_ID: "test-client-id",
          GOOGLE_CLIENT_SECRET: "test-client-secret",
          JWT_SECRET: "test-jwt-secret-for-development-only",
        },
      },
    }),
  ],
});
