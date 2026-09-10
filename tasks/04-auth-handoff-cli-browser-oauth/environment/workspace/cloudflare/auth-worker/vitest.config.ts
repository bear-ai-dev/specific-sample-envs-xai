import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          BETTER_AUTH_SECRET: "test-only-not-a-production-secret",
        },
      },
      wrangler: {
        configPath: "./wrangler.toml",
      },
    }),
  ],
});
